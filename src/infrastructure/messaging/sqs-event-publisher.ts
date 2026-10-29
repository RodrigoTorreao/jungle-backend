import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishReport } from '../../application/ports/messaging';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { inSpan, SpanKind } from '../observability/spans';
import type { QueueDirectory } from './sqs';

const SQS_BATCH_LIMIT = 10;
/** Concurrent SendMessageBatch calls per publish; each lane keeps its own order. */
const LANES = 4;

/** Stable lane of an aggregate, so all of its messages travel in order through one lane. */
function laneOf(aggregateId: string): number {
  let hash = 0;
  for (let i = 0; i < aggregateId.length; i++) {
    hash = (hash * 31 + aggregateId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % LANES;
}

/**
 * Publishes outbox messages to the events FIFO queue.
 *  - MessageGroupId = aggregateId: SQS keeps per-aggregate order *within what it receives*;
 *    concurrent publishers may still reorder, so consumers order by walletVersion.
 *  - MessageDeduplicationId = eventId: a republish within SQS's 5-minute window is dropped by
 *    the broker; beyond it, consumers deduplicate by eventId (ARCHITECTURE §8.3).
 *  - Batches go out on parallel lanes partitioned by aggregate: every message of one aggregate
 *    shares a lane and is sent in claim order, so the parallelism never reorders a wallet's
 *    events (the load test showed sequential batches capping the relay).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly queues: QueueDirectory,
    private readonly queueName: string,
  ) {}

  publish(messages: readonly OutboxMessage[]): Promise<PublishReport> {
    return inSpan(
      `${this.queueName} publish`,
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          'messaging.system': 'aws_sqs',
          'messaging.destination.name': this.queueName,
          'messaging.batch.message_count': messages.length,
          // One batch spans many requests: their correlation ids join the traces.
          'wagering.correlation_ids': [...new Set(messages.map((m) => m.correlationId))].slice(
            0,
            50,
          ),
        },
      },
      async (span) => {
        const report = await this.publishOnLanes(messages);
        span.setAttribute('wagering.published', report.published.size);
        span.setAttribute('wagering.failed', report.failed.size);
        return report;
      },
    );
  }

  private async publishOnLanes(messages: readonly OutboxMessage[]): Promise<PublishReport> {
    const queueUrl = await this.queues.url(this.queueName);
    const published = new Set<string>();
    const failed = new Map<string, string>();
    const lanes: OutboxMessage[][] = Array.from({ length: LANES }, () => []);
    for (const message of messages) {
      lanes[laneOf(message.aggregateId)]?.push(message);
    }
    await Promise.all(
      lanes.map(async (lane) => {
        for (let start = 0; start < lane.length; start += SQS_BATCH_LIMIT) {
          try {
            await this.sendBatch(queueUrl, lane.slice(start, start + SQS_BATCH_LIMIT), {
              published,
              failed,
            });
          } catch (error) {
            // The rest of this lane waits for a retry (order kept); other lanes are unaffected.
            const reason = error instanceof Error ? error.message : String(error);
            for (const message of lane.slice(start)) {
              failed.set(message.id, reason);
            }
            return;
          }
        }
      }),
    );
    return { published, failed };
  }

  private async sendBatch(
    queueUrl: string,
    chunk: readonly OutboxMessage[],
    report: { published: Set<string>; failed: Map<string, string> },
  ): Promise<void> {
    const { published, failed } = report;
    const byEntryId = new Map(chunk.map((message, index) => [`e${index}`, message]));
    const response = await this.queues.client.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: [...byEntryId].map(([entryId, message]) => ({
          Id: entryId,
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
          MessageAttributes: {
            eventType: { DataType: 'String', StringValue: message.eventType },
            eventVersion: { DataType: 'Number', StringValue: String(message.eventVersion) },
            correlationId: { DataType: 'String', StringValue: message.correlationId },
          },
        })),
      }),
    );
    for (const entry of response.Successful ?? []) {
      const message = entry.Id === undefined ? undefined : byEntryId.get(entry.Id);
      if (message !== undefined) {
        published.add(message.id);
      }
    }
    for (const entry of response.Failed ?? []) {
      const message = entry.Id === undefined ? undefined : byEntryId.get(entry.Id);
      if (message !== undefined) {
        failed.set(message.id, `${entry.Code ?? 'Failed'}: ${entry.Message ?? ''}`.trim());
      }
    }
  }
}
