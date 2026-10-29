/**
 * Stable, machine-readable failure taxonomy (ARCHITECTURE §9.2).
 * A provider decides from the code alone whether to resend, fix the payload or give up.
 */
export enum FailureCode {
  // Business rules — persisted as REJECTED
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceKindNotReversible = 'REFERENCE_KIND_NOT_REVERSIBLE',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',
  // Business rule without an aggregate to attach to — not persisted
  WalletNotFound = 'WALLET_NOT_FOUND',
  // Validation — not persisted
  ValidationError = 'VALIDATION_ERROR',
  InvalidMoney = 'INVALID_MONEY',
  UnsupportedKind = 'UNSUPPORTED_KIND',
  MissingReference = 'MISSING_REFERENCE',
  // Conflicts — not persisted
  IdempotencyKeyConflict = 'IDEMPOTENCY_KEY_CONFLICT',
  ExternalTransactionIdConflict = 'EXTERNAL_TRANSACTION_ID_CONFLICT',
  // Transient infrastructure — not persisted, safe to resend unchanged
  DatabaseUnavailable = 'DATABASE_UNAVAILABLE',
  LockTimeout = 'LOCK_TIMEOUT',
  ConcurrencyConflict = 'CONCURRENCY_CONFLICT',
  BrokerUnavailable = 'BROKER_UNAVAILABLE',
  // Permanent infrastructure — persisted as FAILED
  InvariantViolation = 'INVARIANT_VIOLATION',
  ProcessingRetriesExhausted = 'PROCESSING_RETRIES_EXHAUSTED',
}

export enum FailureCategory {
  Business = 'BUSINESS',
  Validation = 'VALIDATION',
  Conflict = 'CONFLICT',
  Transient = 'TRANSIENT',
  Permanent = 'PERMANENT',
}

/** What the provider should do with a failed submission. */
export enum ProviderAction {
  ResendUnchanged = 'RESEND_UNCHANGED',
  FixPayload = 'FIX_PAYLOAD',
  DoNotResend = 'DO_NOT_RESEND',
  GiveUp = 'GIVE_UP',
  Escalate = 'ESCALATE',
}

export interface FailureCodeDescriptor {
  readonly category: FailureCategory;
  readonly retryable: boolean;
  /** Terminal status the transaction is stored with, or undefined when nothing is persisted. */
  readonly persistedAs: 'REJECTED' | 'FAILED' | undefined;
  readonly providerAction: ProviderAction;
}

const business = (providerAction: ProviderAction): FailureCodeDescriptor => ({
  category: FailureCategory.Business,
  retryable: false,
  persistedAs: 'REJECTED',
  providerAction,
});

const notPersisted = (
  category: FailureCategory,
  retryable: boolean,
  providerAction: ProviderAction,
): FailureCodeDescriptor => ({ category, retryable, persistedAs: undefined, providerAction });

const permanent: FailureCodeDescriptor = {
  category: FailureCategory.Permanent,
  retryable: false,
  persistedAs: 'FAILED',
  providerAction: ProviderAction.Escalate,
};

export const FAILURE_CODES: Readonly<Record<FailureCode, FailureCodeDescriptor>> = Object.freeze({
  [FailureCode.InsufficientFunds]: business(ProviderAction.GiveUp),
  [FailureCode.ReversalWouldOverdraw]: business(ProviderAction.Escalate),
  [FailureCode.CurrencyMismatch]: business(ProviderAction.FixPayload),
  [FailureCode.WalletPlayerMismatch]: business(ProviderAction.FixPayload),
  [FailureCode.ReferenceNotFound]: business(ProviderAction.FixPayload),
  [FailureCode.ReferenceMismatch]: business(ProviderAction.FixPayload),
  [FailureCode.ReferenceKindNotReversible]: business(ProviderAction.FixPayload),
  [FailureCode.ReferenceNotProcessed]: business(ProviderAction.GiveUp),
  [FailureCode.ReferenceAlreadyReversed]: business(ProviderAction.GiveUp),
  [FailureCode.ReversalAmountMismatch]: business(ProviderAction.FixPayload),
  [FailureCode.WalletNotFound]: notPersisted(
    FailureCategory.Business,
    false,
    ProviderAction.FixPayload,
  ),
  [FailureCode.ValidationError]: notPersisted(
    FailureCategory.Validation,
    false,
    ProviderAction.FixPayload,
  ),
  [FailureCode.InvalidMoney]: notPersisted(
    FailureCategory.Validation,
    false,
    ProviderAction.FixPayload,
  ),
  [FailureCode.UnsupportedKind]: notPersisted(
    FailureCategory.Validation,
    false,
    ProviderAction.FixPayload,
  ),
  [FailureCode.MissingReference]: notPersisted(
    FailureCategory.Validation,
    false,
    ProviderAction.FixPayload,
  ),
  [FailureCode.IdempotencyKeyConflict]: notPersisted(
    FailureCategory.Conflict,
    false,
    ProviderAction.DoNotResend,
  ),
  [FailureCode.ExternalTransactionIdConflict]: notPersisted(
    FailureCategory.Conflict,
    false,
    ProviderAction.DoNotResend,
  ),
  [FailureCode.DatabaseUnavailable]: notPersisted(
    FailureCategory.Transient,
    true,
    ProviderAction.ResendUnchanged,
  ),
  [FailureCode.LockTimeout]: notPersisted(
    FailureCategory.Transient,
    true,
    ProviderAction.ResendUnchanged,
  ),
  [FailureCode.ConcurrencyConflict]: notPersisted(
    FailureCategory.Transient,
    true,
    ProviderAction.ResendUnchanged,
  ),
  [FailureCode.BrokerUnavailable]: notPersisted(
    FailureCategory.Transient,
    true,
    ProviderAction.ResendUnchanged,
  ),
  [FailureCode.InvariantViolation]: permanent,
  [FailureCode.ProcessingRetriesExhausted]: permanent,
});

export function describeFailure(code: FailureCode): FailureCodeDescriptor {
  return FAILURE_CODES[code];
}
