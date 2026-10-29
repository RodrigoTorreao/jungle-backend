import { addMilliseconds } from './guards';

export interface BackoffPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/**
 * Deterministic exponential backoff: base * 2^attempt, capped.
 * No jitter on purpose: the domain stays deterministic and testable, and concurrent workers
 * already avoid each other with `FOR UPDATE SKIP LOCKED` (ARCHITECTURE §8.3).
 */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy): number {
  const raw = policy.baseDelayMs * 2 ** attempt;
  return raw > policy.maxDelayMs ? policy.maxDelayMs : raw;
}

export function nextAttemptAt(now: Date, attempt: number, policy: BackoffPolicy): Date {
  return addMilliseconds(now, backoffDelayMs(attempt, policy));
}
