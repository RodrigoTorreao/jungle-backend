import { describe, expect, test } from 'bun:test';
import type { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import type { QueueDirectory } from '../../../src/infrastructure/messaging/sqs';
import { SqsEventPublisher } from '../../../src/infrastructure/messaging/sqs-event-publisher';

const message = (aggregateId: string, sequence: number) =>
  OutboxMessage.rehydrate({
    id: `${aggregateId}-${sequence}`,
    aggregateId,
    eventType: 'WalletBalanceChanged',
    eventVersion: 1,
    correlationId: 'corr',
    payload: { sequence },
    occurredAt: new Date('2026-10-29T12:00:00Z'),
    attempts: 0,
    nextAttemptAt: new Date('2026-10-29T12:00:00Z'),
  });

/** A fake broker: records every batch, optionally failing the calls `failWhen` selects. */
function publisherWith(failWhen: (ids: string[]) => boolean = () => false) {
  const sent: string[][] = [];
  const client = {
    send: async (command: SendMessageBatchCommand) => {
      const ids = (command.input.Entries ?? []).map((entry) => entry.MessageDeduplicationId ?? '');
      await Bun.sleep(Math.random() * 3); // lanes interleave
      if (failWhen(ids)) {
        throw new Error('connection reset');
      }
      sent.push(ids);
      return { Successful: (command.input.Entries ?? []).map((entry) => ({ Id: entry.Id })) };
    },
  } as unknown as SQSClient;
  const queues = { client, url: async () => 'http://sqs/events.fifo' } as unknown as QueueDirectory;
  return { publisher: new SqsEventPublisher(queues, 'events.fifo'), sent };
}

// 12 aggregates × 8 events, claimed interleaved (oldest first across aggregates).
const aggregates = Array.from({ length: 12 }, (_, i) => `wallet-${i}`);
const batch = Array.from({ length: 8 }, (_, sequence) =>
  aggregates.map((aggregate) => message(aggregate, sequence)),
).flat();

describe('SqsEventPublisher lanes', () => {
  test('parallel lanes never reorder the events of one aggregate', async () => {
    const { publisher, sent } = publisherWith();
    const report = await publisher.publish(batch);

    expect(report.published.size).toBe(batch.length);
    expect(sent.every((ids) => ids.length <= 10)).toBe(true);
    const order = sent.flat();
    for (const aggregate of aggregates) {
      const sequence = order.filter((id) => id.startsWith(`${aggregate}-`));
      expect(sequence).toEqual(Array.from({ length: 8 }, (_, i) => `${aggregate}-${i}`));
    }
  });

  test('a failed send fails the rest of its lane only; the other lanes are published', async () => {
    let failed = false;
    const { publisher } = publisherWith((ids) => {
      if (!failed && ids.includes('wallet-3-2')) {
        failed = true;
        return true;
      }
      return false;
    });
    const report = await publisher.publish(batch);

    expect(report.failed.has('wallet-3-2')).toBe(true);
    // Nothing of wallet-3 after the failure goes out ahead of it.
    for (let sequence = 2; sequence < 8; sequence++) {
      expect(report.published.has(`wallet-3-${sequence}`)).toBe(false);
    }
    expect(report.published.size + report.failed.size).toBe(batch.length);
    expect(report.published.size).toBeGreaterThan(batch.length / 2);
  });
});
