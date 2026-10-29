import { type BackoffPolicy, backoffDelayMs } from '../../domain/shared/backoff';
import { ConcurrencyConflictError, TransientInfrastructureError } from '../errors';
import type { LockConflictType, Metrics } from '../ports/observability';

export interface TransientRetryPolicy extends BackoffPolicy {
  readonly maxAttempts: number;
}

/**
 * 3 attempts, 20ms then 40ms. Lock waits already serialize writers of the same wallet, so a
 * retry here only absorbs the rare deadlock, lock timeout or duplicate-insert race.
 */
export const DEFAULT_TRANSIENT_RETRY: TransientRetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 20,
  maxDelayMs: 200,
});

export function isRetryable(error: unknown): boolean {
  return error instanceof TransientInfrastructureError || error instanceof ConcurrencyConflictError;
}

export interface TransientFailure {
  readonly error: unknown;
  readonly attempt: number;
  readonly willRetry: boolean;
}

/**
 * Re-runs `operation` (a whole SQL transaction) on transient failures. The operation must be
 * idempotent per attempt: it rebuilds every domain object from the database each time.
 * When attempts run out, the transient error propagates (HTTP 503 / SQS retry).
 * `onTransientFailure` sees every transient failure, the last one included.
 */
export async function withTransientRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: TransientRetryPolicy = DEFAULT_TRANSIENT_RETRY,
  onTransientFailure?: (failure: TransientFailure) => void,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isRetryable(error)) {
        throw error;
      }
      const willRetry = attempt < policy.maxAttempts;
      onTransientFailure?.({ error, attempt, willRetry });
      if (!willRetry) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt - 1, policy)));
    }
  }
}

/** Records retries and lock conflicts of a transient failure (ARCHITECTURE §10). */
export function recordTransientFailure(metrics: Metrics, failure: TransientFailure): void {
  const type: LockConflictType | undefined =
    failure.error instanceof ConcurrencyConflictError
      ? 'version'
      : failure.error instanceof TransientInfrastructureError
        ? failure.error.reason
        : undefined;
  if (
    type === 'lock_timeout' ||
    type === 'deadlock' ||
    type === 'serialization' ||
    type === 'version'
  ) {
    metrics.lockConflict(type);
  }
  if (failure.willRetry) {
    metrics.processingRetry(type ?? 'unknown');
  }
}
