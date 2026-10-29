import type { Money } from '../money/money';
import { type BackoffPolicy, nextAttemptAt } from '../shared/backoff';
import {
  DomainError,
  DomainValidationError,
  InvariantViolationError,
} from '../shared/domain-error';
import { assertNonEmpty } from '../shared/guards';
import { invertDirection, LedgerDirection } from '../wallet/ledger-direction';
import { describeFailure, FailureCode } from './failure-code';
import {
  EXTERNAL_KINDS,
  TERMINAL_STATUSES,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction-kind';

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(transactionId: string, from: WagerTransactionStatus, action: string) {
    super(`Transaction ${transactionId}: cannot ${action} from status ${from}`);
  }
}

export interface ReferenceRetryPolicy extends BackoffPolicy {
  readonly maxAttempts: number;
  readonly ttlMs: number;
}

/** 1s, 2s, 4s … capped at 5 min; at most 10 attempts or 15 min (ARCHITECTURE §8.4). */
export const DEFAULT_REFERENCE_RETRY_POLICY: ReferenceRetryPolicy = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  maxAttempts: 10,
  ttlMs: 900_000,
});

export const INTERNAL_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** Provider-side id of the referenced transaction — not the internal id. */
  readonly referenceExternalTransactionId?: string | undefined;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string | undefined;
  readonly failureCode?: FailureCode | undefined;
  readonly processedAt?: Date | undefined;
  /** Balance observed when the outcome was decided; replayed verbatim on idempotent retries. */
  readonly resultBalance?: Money | undefined;
  readonly referenceAttempts: number;
  readonly nextAttemptAt?: Date | undefined;
}

export interface OpeningTransactionProps {
  readonly id: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly payloadHash: string;
  readonly at: Date;
}

/**
 * A provider operation on a round. Valid transitions:
 *
 *   PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED (and reschedules itself while waiting)
 *   PROCESSED, REJECTED, FAILED are terminal: any further transition is a programming error.
 */
export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _resultBalance: Money | undefined;
  private _referenceAttempts: number;
  private _nextAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = new Date(state.createdAt.getTime());
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._resultBalance = state.resultBalance;
    this._referenceAttempts = state.referenceAttempts;
    this._nextAttemptAt = state.nextAttemptAt;
  }

  /** A provider submission. Born PENDING; validates the reference requirement per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    for (const field of [
      'id',
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'payloadHash',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ] as const) {
      assertNonEmpty(props[field], field);
    }
    if (!EXTERNAL_KINDS.has(props.kind)) {
      throw new DomainValidationError(
        FailureCode.UnsupportedKind,
        `Kind ${props.kind} cannot be submitted by a provider`,
      );
    }
    const reference = props.referenceExternalTransactionId;
    if (reference !== undefined) {
      assertNonEmpty(reference, 'referenceExternalTransactionId');
      if (reference === props.externalTransactionId) {
        throw new DomainValidationError(
          FailureCode.ValidationError,
          'A transaction cannot reference itself',
        );
      }
      if (props.kind === WagerTransactionKind.Bet) {
        throw new DomainValidationError(
          FailureCode.ValidationError,
          'BET does not take a reference',
        );
      }
    }
    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      reference === undefined
    ) {
      throw new DomainValidationError(
        FailureCode.MissingReference,
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    const zeroAllowed = props.kind === WagerTransactionKind.Loss;
    if (props.money.isNegative() || (!zeroAllowed && props.money.isZero())) {
      throw new DomainValidationError(
        FailureCode.InvalidMoney,
        `${props.kind} requires a ${zeroAllowed ? 'non-negative' : 'positive'} amount`,
      );
    }
    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
    });
  }

  /** Internal OPENING credit created together with a wallet. Already PROCESSED. */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvariantViolationError('An OPENING transaction must credit a positive amount');
    }
    const externalId = `opening:${props.walletId}`;
    return new WagerTransaction({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: externalId,
      idempotencyKey: externalId,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
      status: WagerTransactionStatus.Processed,
      processedAt: props.at,
      resultBalance: props.money,
      referenceAttempts: 0,
    });
  }

  /** Rebuilds persisted state. Does not re-validate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  // ---- transitions

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultBalance: Money): void {
    this.assertResolvable('mark processed');
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvariantViolationError(
        `${this.kind} ${this.id} cannot be processed without a resolved reference`,
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextAttemptAt = undefined;
  }

  /** The referenced transaction has not arrived yet: wait and retry later. */
  markPendingReference(
    now: Date,
    observedBalance: Money,
    policy: ReferenceRetryPolicy = DEFAULT_REFERENCE_RETRY_POLICY,
  ): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(this.id, this._status, 'mark pending reference');
    }
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvariantViolationError(`${this.id} has no reference to wait for`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._resultBalance = observedBalance;
    this._referenceAttempts = 0;
    this._nextAttemptAt = nextAttemptAt(now, 0, policy);
  }

  /** Another unsuccessful look for the reference: back off before the next one. */
  scheduleReferenceRetry(
    now: Date,
    policy: ReferenceRetryPolicy = DEFAULT_REFERENCE_RETRY_POLICY,
  ): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this.id, this._status, 'schedule a reference retry');
    }
    this._referenceAttempts += 1;
    this._nextAttemptAt = nextAttemptAt(now, this._referenceAttempts, policy);
  }

  /** True once the attempt limit or the TTL is reached: the reference is considered missing. */
  isReferenceWaitExhausted(
    now: Date,
    policy: ReferenceRetryPolicy = DEFAULT_REFERENCE_RETRY_POLICY,
  ): boolean {
    return (
      this._referenceAttempts >= policy.maxAttempts ||
      now.getTime() - this.createdAt.getTime() >= policy.ttlMs
    );
  }

  reject(code: FailureCode, at: Date, observedBalance: Money): void {
    this.assertResolvable('reject');
    if (describeFailure(code).persistedAs !== 'REJECTED') {
      throw new InvariantViolationError(`${code} is not a business rejection code`);
    }
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._resultBalance = observedBalance;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertResolvable('fail');
    if (describeFailure(code).persistedAs !== 'FAILED') {
      throw new InvariantViolationError(`${code} is not a permanent failure code`);
    }
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Direction of the ledger entry this transaction produces. ROLLBACK inverts its reference. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (reference === undefined || !REVERSIBLE_BY_ROLLBACK.has(reference.kind)) {
          throw new InvariantViolationError(
            `ROLLBACK ${this.id} needs a BET, WIN or REFUND reference to define its direction`,
          );
        }
        return invertDirection(reference.ledgerDirectionFor());
      }
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError('LOSS does not produce a ledger entry');
    }
  }

  private assertResolvable(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, action);
    }
  }
}

export const REVERSIBLE_BY_ROLLBACK: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);
