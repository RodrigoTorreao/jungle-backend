import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishReport } from '../../application/ports/messaging';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { QueueDirectory } from './sqs';

const SQS_BATCH_LIMIT = 10;

/**
 * Publishes outbox messages to the events FIFO queue.
 *  - MessageGroupId = aggregateId: SQS keeps per-aggregate order *within what it receives*;
 *    concurrent publishers may still reorder, so consumers order by walletVersion.
 *  - MessageDeduplicationId = eventId: a republish within SQS's 5-minute window is dropped by
 *    the broker; beyond it, consumers deduplicate by eventId (ARCHITECTURE §8.3).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly queues: QueueDirectory,
    private readonly queueName: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishReport> {
    const queueUrl = await this.queues.url(this.queueName);
    const published = new Set<string>();
    const failed = new Map<string, string>();

    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(start, start + SQS_BATCH_LIMIT);
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
    return { published, failed };
  }
}
