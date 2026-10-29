/**
 * Base class for every error raised by the domain layer.
 * `code` is stable and machine-readable; the HTTP/SQS adapters map it, the domain never does.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A guard that should be impossible to trip through the public use cases.
 * Seeing one means a programming error, not a business outcome.
 */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
  }
}

/** Input that cannot be represented in the domain (malformed, empty, out of contract). */
export class DomainValidationError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
