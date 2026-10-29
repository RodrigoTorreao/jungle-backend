import { InvariantViolationError } from '../shared/domain-error';
import { LedgerDirection } from '../wallet/ledger-direction';
import type { Wallet } from '../wallet/wallet';
import type { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import {
  DEFAULT_REFERENCE_RETRY_POLICY,
  InvalidTransactionStateError,
  REVERSIBLE_BY_ROLLBACK,
  type ReferenceRetryPolicy,
  type WagerTransaction,
} from './wager-transaction';
import { WagerTransactionKind, WagerTransactionStatus } from './wager-transaction-kind';

export interface WagerPolicyInput {
  /** PENDING (new submission) or PENDING_REFERENCE (re-evaluation by the worker). */
  readonly transaction: WagerTransaction;
  /** Locked by the caller: this function must run inside the wallet's critical section. */
  readonly wallet: Wallet;
  /** Resolved by (providerId, referenceExternalTransactionId); undefined when not found. */
  readonly reference: WagerTransaction | undefined;
  /** Whether the reference already has a PROCESSED REFUND or ROLLBACK (interpretation I-01). */
  readonly referenceAlreadyReversed: boolean;
  readonly ledgerEntryId: string;
  readonly now: Date;
  readonly referenceRetryPolicy?: ReferenceRetryPolicy;
}

export type WagerOutcome =
  | {
      readonly status: WagerTransactionStatus.Processed;
      /** Undefined for LOSS, which records the result without moving the balance. */
      readonly ledgerEntry: WalletLedgerEntry | undefined;
    }
  | { readonly status: WagerTransactionStatus.Rejected; readonly failureCode: FailureCode }
  | { readonly status: WagerTransactionStatus.PendingReference };

/**
 * Applies a provider operation to a wallet (ARCHITECTURE §4.4). Mutates the transaction and,
 * when the operation is accepted, the wallet; returns what happened so the caller can persist
 * it and emit the matching events. Never leaves a half-applied state: every rejection is
 * decided before the wallet is touched.
 */
export function applyWagerPolicy(input: WagerPolicyInput): WagerOutcome {
  const { transaction: tx, wallet, now } = input;
  if (tx.walletId !== wallet.id) {
    throw new InvariantViolationError(`Transaction ${tx.id} targets another wallet`);
  }
  if (tx.isTerminal()) {
    throw new InvalidTransactionStateError(tx.id, tx.status, 'apply the wager policy');
  }

  const reject = (failureCode: FailureCode): WagerOutcome => {
    tx.reject(failureCode, now, wallet.balance);
    return { status: WagerTransactionStatus.Rejected, failureCode };
  };
  const waitForReference = (): WagerOutcome => {
    if (tx.status === WagerTransactionStatus.Pending) {
      tx.markPendingReference(
        now,
        wallet.balance,
        input.referenceRetryPolicy ?? DEFAULT_REFERENCE_RETRY_POLICY,
      );
    }
    return { status: WagerTransactionStatus.PendingReference };
  };

  if (tx.playerId !== wallet.playerId) {
    return reject(FailureCode.WalletPlayerMismatch);
  }
  if (tx.money.currency !== wallet.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  let reference: WagerTransaction | undefined;
  if (tx.referenceExternalTransactionId !== undefined) {
    const candidate = input.reference;
    if (candidate === undefined) {
      return waitForReference();
    }
    if (
      candidate.providerId !== tx.providerId ||
      candidate.externalTransactionId !== tx.referenceExternalTransactionId
    ) {
      throw new InvariantViolationError(`Reference resolved for ${tx.id} is not the one it names`);
    }
    const failure = referenceFailure(tx, candidate, input.referenceAlreadyReversed);
    if (failure === 'wait') {
      return waitForReference();
    }
    if (failure !== undefined) {
      return reject(failure);
    }
    reference = candidate;
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, now, wallet.balance);
    return { status: WagerTransactionStatus.Processed, ledgerEntry: undefined };
  }

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    // A reversal that would overdraw is operationally different from a bet without funds.
    return reject(
      tx.kind === WagerTransactionKind.Bet
        ? FailureCode.InsufficientFunds
        : FailureCode.ReversalWouldOverdraw,
    );
  }

  const movement = {
    ledgerEntryId: input.ledgerEntryId,
    transactionId: tx.id,
    money: tx.money,
    at: now,
  };
  const ledgerEntry =
    direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  tx.markProcessed(reference?.id, now, wallet.balance);
  return { status: WagerTransactionStatus.Processed, ledgerEntry };
}

/**
 * Validates a found reference. Returns the rejection code, 'wait' when the reference exists
 * but is itself still unresolved, or undefined when it can be used.
 */
function referenceFailure(
  tx: WagerTransaction,
  reference: WagerTransaction,
  alreadyReversed: boolean,
): FailureCode | 'wait' | undefined {
  if (
    reference.playerId !== tx.playerId ||
    reference.walletId !== tx.walletId ||
    reference.money.currency !== tx.money.currency ||
    reference.roundId !== tx.roundId
  ) {
    return FailureCode.ReferenceMismatch;
  }
  if (
    reference.status === WagerTransactionStatus.Pending ||
    reference.status === WagerTransactionStatus.PendingReference
  ) {
    return 'wait';
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }

  switch (tx.kind) {
    case WagerTransactionKind.Win:
    case WagerTransactionKind.Loss:
      // A round result may point at the bet it settles, and only at a bet.
      return reference.kind === WagerTransactionKind.Bet
        ? undefined
        : FailureCode.ReferenceMismatch;
    case WagerTransactionKind.Refund:
    case WagerTransactionKind.Rollback: {
      const reversible =
        tx.kind === WagerTransactionKind.Refund
          ? reference.kind === WagerTransactionKind.Bet
          : REVERSIBLE_BY_ROLLBACK.has(reference.kind);
      if (!reversible) {
        return FailureCode.ReferenceKindNotReversible;
      }
      if (!reference.money.equals(tx.money)) {
        return FailureCode.ReversalAmountMismatch;
      }
      return alreadyReversed ? FailureCode.ReferenceAlreadyReversed : undefined;
    }
    default:
      throw new InvariantViolationError(`${tx.kind} does not take a reference`);
  }
}
