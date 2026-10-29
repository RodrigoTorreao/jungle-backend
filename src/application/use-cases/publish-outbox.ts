import { DEFAULT_OUTBOX_RETRY_POLICY } from '../../domain/messaging/outbox-message';
import type { BackoffPolicy } from '../../domain/shared/backoff';
import type { FaultInjector } from '../ports/fault-injector';
import type { EventPublisher, PublishReport } from '../ports/messaging';
import { type Metrics, noopMetrics } from '../ports/observability';
import type { UnitOfWork } from '../ports/persistence';
import type { Clock } from '../ports/system';

export interface OutboxBatchReport {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

/**
 * Transactional outbox relay (Desafio §11, ARCHITECTURE §8.3). In one short SQL transaction:
 * claim due rows with FOR UPDATE SKIP LOCKED → publish → mark published or schedule a retry →
 * COMMIT. Concurrent publishers never claim the same row; if this process dies anywhere before
 * COMMIT its locks vanish with the connection and another publisher takes the rows over — at
 * worst publishing them again with the same eventId (at-least-once, never lost).
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly faults: FaultInjector,
    private readonly metrics: Metrics = noopMetrics,
    private readonly retryPolicy: BackoffPolicy = DEFAULT_OUTBOX_RETRY_POLICY,
  ) {}

  publishDueBatch(limit: number): Promise<OutboxBatchReport> {
    return this.unitOfWork.run(async (scope) => {
      const due = await scope.outbox.claimDue(this.clock.now(), limit);
      if (due.length === 0) {
        return { claimed: 0, published: 0, failed: 0 };
      }

      let report: PublishReport;
      try {
        report = await this.publisher.publish(due);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        report = { published: new Set(), failed: new Map(due.map((m) => [m.id, reason])) };
      }
      this.faults.hit('after-publish-before-mark');

      const now = this.clock.now();
      for (const message of due) {
        if (report.published.has(message.id)) {
          message.markPublished(now);
        } else {
          message.scheduleRetry(
            now,
            report.failed.get(message.id) ?? 'not acknowledged',
            this.retryPolicy,
          );
        }
        await scope.outbox.update(message);
      }
      this.metrics.outboxPublish('published', report.published.size);
      this.metrics.outboxPublish('failed', due.length - report.published.size);
      return {
        claimed: due.length,
        published: report.published.size,
        failed: due.length - report.published.size,
      };
    });
  }
}
