import { FailureCode } from '../domain/wagering/failure-code';

/**
 * Errors raised by use cases and ports. Each carries a stable `code`; adapters (HTTP filter,
 * SQS consumer) map codes to transport semantics — the application never knows about HTTP.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

/** A request argument the use case cannot interpret (e.g. a tampered cursor). */
export class InvalidRequestError extends ApplicationError {
  readonly code = FailureCode.ValidationError;

  constructor(message: string) {
    super(message);
  }
}

/** Missing or invalid credentials. */
export class UnauthenticatedError extends ApplicationError {
  readonly code = 'UNAUTHENTICATED';

  constructor(message = 'Missing or invalid credentials') {
    super(message);
  }
}

/** The authenticated provider is not the one named in the payload. */
export class ProviderMismatchError extends ApplicationError {
  readonly code = 'PROVIDER_MISMATCH';

  constructor(message = 'The authenticated caller cannot act for this provider') {
    super(message);
  }
}

/** The caller is authenticated but lacks the role the operation requires (backoffice routes). */
export class ForbiddenError extends ApplicationError {
  readonly code = 'FORBIDDEN';

  constructor(message = 'This operation requires the backoffice role') {
    super(message);
  }
}

/** The IdP's signing keys cannot be fetched (and none are cached): retry later. */
export class IdentityProviderUnavailableError extends ApplicationError {
  readonly code = 'IDENTITY_PROVIDER_UNAVAILABLE';

  constructor(options?: { cause?: unknown }) {
    super('The identity provider is unavailable');
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Same Idempotency-Key with a different payload: a conflict, never a replay (RN-14). */
export class IdempotencyKeyConflictError extends ApplicationError {
  readonly code = FailureCode.IdempotencyKeyConflict;

  constructor(providerId: string, idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} of ${providerId} was used with another payload`);
  }
}

/** Another Idempotency-Key already claimed this provider transaction id. */
export class ExternalTransactionIdConflictError extends ApplicationError {
  readonly code = FailureCode.ExternalTransactionIdConflict;

  constructor(providerId: string, externalTransactionId: string) {
    super(`Transaction ${externalTransactionId} of ${providerId} was submitted with another key`);
  }
}

/** A messageId already consumed with a different payload: a producer bug, not a redelivery (I-10). */
export class InboxPayloadMismatchError extends ApplicationError {
  readonly code = 'INBOX_PAYLOAD_MISMATCH';

  constructor(consumerName: string, messageId: string) {
    super(`Message ${messageId} was already consumed by ${consumerName} with another payload`);
  }
}

/** The target wallet does not exist; nothing is persisted (interpretation I-04). */
export class WalletNotFoundError extends ApplicationError {
  readonly code = FailureCode.WalletNotFound;

  constructor(walletId: string) {
    super(`Wallet ${walletId} does not exist`);
  }
}

export class ResourceNotFoundError extends ApplicationError {
  readonly code = 'NOT_FOUND';

  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`);
  }
}

/** The wallet row changed between the locked read and the guarded update. Retryable. */
export class ConcurrencyConflictError extends ApplicationError {
  readonly code = FailureCode.ConcurrencyConflict;

  constructor(walletId: string, expectedVersion: number) {
    super(`Wallet ${walletId} is no longer at version ${expectedVersion}`);
  }
}

/** Why a transient failure happened — the label of retry and lock-conflict metrics. */
export type TransientReason =
  | 'lock_timeout'
  | 'deadlock'
  | 'serialization'
  | 'duplicate_key_race'
  | 'connection'
  | 'broker';

const DEFAULT_REASON: Record<TransientInfrastructureError['code'], TransientReason> = {
  [FailureCode.DatabaseUnavailable]: 'connection',
  [FailureCode.LockTimeout]: 'lock_timeout',
  [FailureCode.ConcurrencyConflict]: 'deadlock',
  [FailureCode.BrokerUnavailable]: 'broker',
};

/** PostgreSQL or SQS temporarily unavailable, lock timeout, deadlock… Safe to retry unchanged. */
export class TransientInfrastructureError extends ApplicationError {
  readonly reason: TransientReason;

  constructor(
    readonly code:
      | FailureCode.DatabaseUnavailable
      | FailureCode.LockTimeout
      | FailureCode.ConcurrencyConflict
      | FailureCode.BrokerUnavailable,
    message: string,
    options?: { cause?: unknown; reason?: TransientReason },
  ) {
    super(message);
    this.reason = options?.reason ?? DEFAULT_REASON[code];
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** A schema guarantee refused a write the application considered valid: a bug, not a business case. */
export class InvariantBreachError extends ApplicationError {
  readonly code = FailureCode.InvariantViolation;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
