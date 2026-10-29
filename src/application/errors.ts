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

/** PostgreSQL or SQS temporarily unavailable, lock timeout, deadlock… Safe to retry unchanged. */
export class TransientInfrastructureError extends ApplicationError {
  constructor(
    readonly code:
      | FailureCode.DatabaseUnavailable
      | FailureCode.LockTimeout
      | FailureCode.ConcurrencyConflict
      | FailureCode.BrokerUnavailable,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
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
