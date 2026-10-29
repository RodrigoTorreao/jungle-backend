import type { MoneyProps } from '../money/money';
import { InvariantViolationError } from '../shared/domain-error';
import type { FailureCode } from '../wagering/failure-code';
import type { WagerTransaction } from '../wagering/wager-transaction';
import {
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../wagering/wager-transaction-kind';
import type { LedgerDirection } from '../wallet/ledger-direction';
import type { Wallet } from '../wallet/wallet';
import type { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { type EventContext, IntegrationEvent } from './integration-event';

function props<T>(aggregateId: string, ctx: EventContext, data: T) {
  return {
    eventId: ctx.eventId,
    aggregateId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    data,
  };
}

function requireDate(value: Date | undefined, what: string): string {
  if (value === undefined) {
    throw new InvariantViolationError(`Event needs ${what}`);
  }
  return value.toISOString();
}

function requireMoney(value: { toJSON(): MoneyProps } | undefined, what: string): MoneyProps {
  if (value === undefined) {
    throw new InvariantViolationError(`Event needs ${what}`);
  }
  return value.toJSON();
}

interface TransactionRef {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
}

function transactionRef(tx: WagerTransaction): TransactionRef {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

function assertStatus(tx: WagerTransaction, expected: WagerTransactionStatus): void {
  if (tx.status !== expected) {
    throw new InvariantViolationError(`Event expects ${expected}, transaction is ${tx.status}`);
  }
}

// ---------------------------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends TransactionRef {
  readonly referenceTransactionId?: string;
  readonly balance: MoneyProps;
  readonly processedAt: string;
}

/** Any applied transaction, including LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(tx, WagerTransactionStatus.Processed);
    return new WagerTransactionProcessed(
      props(tx.id, ctx, {
        ...transactionRef(tx),
        ...(tx.referenceTransactionId === undefined
          ? {}
          : { referenceTransactionId: tx.referenceTransactionId }),
        balance: requireMoney(tx.resultBalance, 'the resulting balance'),
        processedAt: requireDate(tx.processedAt, 'processedAt'),
      }),
    );
  }
}

export interface WagerTransactionRejectedData extends TransactionRef {
  readonly failureCode: FailureCode;
  readonly rejectedAt: string;
}

/** Business rule rejection (including a reference that never arrived). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(tx, WagerTransactionStatus.Rejected);
    if (tx.failureCode === undefined) {
      throw new InvariantViolationError('A rejected transaction must carry a failure code');
    }
    return new WagerTransactionRejected(
      props(tx.id, ctx, {
        ...transactionRef(tx),
        failureCode: tx.failureCode,
        rejectedAt: requireDate(tx.processedAt, 'the rejection time'),
      }),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionRef {
  readonly referenceExternalTransactionId: string;
  readonly nextAttemptAt: string;
}

/** The referenced transaction has not arrived yet; the operation is parked, not lost. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(tx, WagerTransactionStatus.PendingReference);
    if (tx.referenceExternalTransactionId === undefined) {
      throw new InvariantViolationError('A pending-reference transaction must name a reference');
    }
    return new WagerTransactionPendingReference(
      props(tx.id, ctx, {
        ...transactionRef(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        nextAttemptAt: requireDate(tx.nextAttemptAt, 'nextAttemptAt'),
      }),
    );
  }
}

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  /** Consumers order balance changes by this, since publishers may reorder events. */
  readonly walletVersion: number;
}

/** Only when the balance actually changes (includes the OPENING credit). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvariantViolationError('Ledger entry belongs to another wallet');
    }
    return new WalletBalanceChanged(
      props(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      }),
    );
  }
}

export interface WalletOpenedData {
  readonly walletId: string;
  readonly playerId: string;
  readonly currency: string;
  readonly initialBalance: MoneyProps;
}

export class WalletOpened extends IntegrationEvent<WalletOpenedData> {
  readonly eventType = 'WalletOpened';
  readonly version = 1;

  static from(wallet: Wallet, initialBalance: MoneyProps, ctx: EventContext): WalletOpened {
    return new WalletOpened(
      props(wallet.id, ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        initialBalance,
      }),
    );
  }
}
