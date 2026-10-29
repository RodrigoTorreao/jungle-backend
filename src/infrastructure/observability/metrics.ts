import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import type {
  LockConflictType,
  MessageSource,
  Metrics,
  ProcessingOutcome,
} from '../../application/ports/observability';

/**
 * prom-client adapter for the catalogue of ARCHITECTURE §10. Each application instance owns its
 * registry (never the global default), so tests and several apps in one process never share
 * counters. Exposed at GET /metrics.
 */
export class PromMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'New outcomes decided and committed (replays excluded)',
    labelNames: ['kind', 'status', 'source'] as const,
    registers: [this.registry],
  });

  private readonly duration = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'End-to-end processing time of a submission, retries included',
    labelNames: ['kind', 'source', 'outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly replays = new Counter({
    name: 'wagering_idempotent_replays_total',
    help: 'Submissions answered with the stored original outcome',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  private readonly conflicts = new Counter({
    name: 'wagering_idempotency_conflicts_total',
    help: 'Same key (or external id) with a different payload',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  private readonly inboxDuplicates = new Counter({
    name: 'inbox_duplicates_total',
    help: 'Messages already present in the inbox (redeliveries and duplicate sends)',
    labelNames: ['consumer'] as const,
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: 'processing_retries_total',
    help: 'Transient failures retried in-process',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: 'db_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks, serialization failures and stale versions',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  private readonly deadLetters = new Counter({
    name: 'sqs_dlq_messages_total',
    help: 'Messages moved to the dead-letter queue by this consumer',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  private readonly outboxPublishes = new Counter({
    name: 'outbox_publish_total',
    help: 'Outbox messages published or scheduled for retry',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  private readonly reconciliationDivergences = new Counter({
    name: 'wallet_reconciliation_divergences_total',
    help: 'Reconciliations that found the stored balance diverging from the ledger',
    registers: [this.registry],
  });

  constructor(options: { defaultMetrics?: boolean } = {}) {
    if (options.defaultMetrics ?? true) {
      try {
        collectDefaultMetrics({ register: this.registry });
      } catch {
        // Some process collectors are unavailable on a given runtime; business metrics stay.
      }
    }
  }

  transactionOutcome(kind: string, status: string, source: MessageSource): void {
    this.transactions.inc({ kind, status, source });
  }

  processingDuration(
    kind: string,
    source: MessageSource,
    outcome: ProcessingOutcome,
    seconds: number,
  ): void {
    this.duration.observe({ kind, source, outcome }, seconds);
  }

  idempotentReplay(source: MessageSource): void {
    this.replays.inc({ source });
  }

  idempotencyConflict(source: MessageSource): void {
    this.conflicts.inc({ source });
  }

  inboxDuplicate(consumer: string): void {
    this.inboxDuplicates.inc({ consumer });
  }

  processingRetry(reason: string): void {
    this.retries.inc({ reason });
  }

  lockConflict(type: LockConflictType): void {
    this.lockConflicts.inc({ type });
  }

  deadLetter(reason: string): void {
    this.deadLetters.inc({ reason });
  }

  outboxPublish(result: 'published' | 'failed', count: number): void {
    if (count > 0) {
      this.outboxPublishes.inc({ result }, count);
    }
  }

  reconciliationDivergence(): void {
    this.reconciliationDivergences.inc();
  }
}

/** Point-in-time readings, computed when Prometheus scrapes. */
export interface OperationalReadings {
  outboxBacklog(): Promise<{ readonly pending: number; readonly oldestAgeSeconds: number }>;
  pendingReferences(): Promise<number>;
  deadLetterDepth(): Promise<number>;
}

/**
 * Gauges read at scrape time. A failing source (database or SQS down) leaves the gauge unset
 * for that scrape instead of failing the whole /metrics response.
 */
export function registerOperationalGauges(
  registry: Registry,
  readings: OperationalReadings,
  deadLetterQueue: string,
): void {
  const settle = async (read: () => Promise<void>) => {
    try {
      await read();
    } catch {
      // unavailable this scrape; readiness reports the outage
    }
  };
  new Gauge({
    name: 'outbox_pending_messages',
    help: 'Committed events not published yet',
    registers: [registry],
    async collect() {
      await settle(async () => this.set((await readings.outboxBacklog()).pending));
    },
  });
  new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox event (0 when empty)',
    registers: [registry],
    async collect() {
      await settle(async () => this.set((await readings.outboxBacklog()).oldestAgeSeconds));
    },
  });
  new Gauge({
    name: 'pending_reference_transactions',
    help: 'Transactions parked in PENDING_REFERENCE',
    registers: [registry],
    async collect() {
      await settle(async () => this.set(await readings.pendingReferences()));
    },
  });
  new Gauge({
    name: 'sqs_dlq_depth',
    help: 'Messages waiting in the dead-letter queue',
    labelNames: ['queue'] as const,
    registers: [registry],
    async collect() {
      await settle(async () =>
        this.set({ queue: deadLetterQueue }, await readings.deadLetterDepth()),
      );
    },
  });
}
