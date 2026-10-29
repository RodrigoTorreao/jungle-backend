import type { TransientReason } from '../errors';

/**
 * Observability ports used by use cases. Adapters live in infrastructure (pino, prom-client);
 * the use cases only state what happened. Log context must never carry amounts or balances.
 */
export interface AppLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

/** Where a submission entered the system. */
export type MessageSource = 'http' | 'sqs' | 'worker';

/** Outcome label of the processing-duration histogram. */
export type ProcessingOutcome =
  | 'processed'
  | 'rejected'
  | 'pending_reference'
  | 'failed'
  | 'replay'
  | 'conflict'
  | 'error';

export type LockConflictType = TransientReason | 'version';

/** The metric catalogue of ARCHITECTURE §10, as domain-level facts. */
export interface Metrics {
  /** A new outcome was decided and committed (replays excluded). */
  transactionOutcome(kind: string, status: string, source: MessageSource): void;
  processingDuration(
    kind: string,
    source: MessageSource,
    outcome: ProcessingOutcome,
    seconds: number,
  ): void;
  idempotentReplay(source: MessageSource): void;
  idempotencyConflict(source: MessageSource): void;
  inboxDuplicate(consumer: string): void;
  /** A transient failure that will be retried. */
  processingRetry(reason: string): void;
  /** Lock timeout, deadlock, serialization failure or stale version (retried or not). */
  lockConflict(type: LockConflictType): void;
  deadLetter(reason: string): void;
  outboxPublish(result: 'published' | 'failed', count: number): void;
  reconciliationDivergence(): void;
}

/** For use cases built without metrics (unit tests, scripts). */
export const noopMetrics: Metrics = {
  transactionOutcome: () => {},
  processingDuration: () => {},
  idempotentReplay: () => {},
  idempotencyConflict: () => {},
  inboxDuplicate: () => {},
  processingRetry: () => {},
  lockConflict: () => {},
  deadLetter: () => {},
  outboxPublish: () => {},
  reconciliationDivergence: () => {},
};

export const APP_LOGGER = Symbol('AppLogger');
export const METRICS = Symbol('Metrics');
