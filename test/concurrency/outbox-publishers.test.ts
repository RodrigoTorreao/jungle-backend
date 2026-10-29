/**
 * T-C06 / T-I04: two publishers relaying the same outbox at the same time, from independent
 * connection pools. FOR UPDATE SKIP LOCKED means no row is ever claimed by both.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import type { EventPublisher, PublishReport } from '../../src/application/ports/messaging';
import { PublishOutboxUseCase } from '../../src/application/use-cases/publish-outbox';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { NoopFaultInjector } from '../../src/infrastructure/system/fault-injectors';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertLedgerConsistency } from '../support/ledger-consistency';
import { clock, connectPersistence, ids, type Persistence } from '../support/persistence';
import { createTestQueues, drain, type TestQueues, testSqsClient } from '../support/sqs';

const WALLETS = 60; // 2 events each → 120 events

let db: TestDatabase;
let publisherA: Persistence;
let publisherB: Persistence;
let sqs: SQSClient;
let queues: TestQueues;

beforeAll(async () => {
  db = await createTestDatabase();
  [publisherA, publisherB] = await Promise.all([connectPersistence(db), connectPersistence(db)]);
  sqs = testSqsClient();
  queues = await createTestQueues(sqs);
});

afterAll(async () => {
  await queues.cleanup();
  sqs.destroy();
  await Promise.all([publisherA.close(), publisherB.close()]);
  await db.drop();
});

/** Real SQS publisher that also records which instance sent which eventId. */
class RecordingPublisher implements EventPublisher {
  constructor(
    private readonly inner: EventPublisher,
    private readonly sent: Map<string, string[]>,
    private readonly name: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishReport> {
    for (const message of messages) {
      this.sent.set(message.id, [...(this.sent.get(message.id) ?? []), this.name]);
    }
    return this.inner.publish(messages);
  }
}

test('every event is claimed and published by exactly one of two concurrent publishers', async () => {
  await Promise.all(
    Array.from({ length: WALLETS }, () =>
      publisherA.createWallet.execute({
        playerId: ids.next(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
        correlationId: 'tc06',
      }),
    ),
  );

  const sent = new Map<string, string[]>();
  const relay = (persistence: Persistence, name: string) =>
    new PublishOutboxUseCase(
      persistence.unitOfWork,
      new RecordingPublisher(new SqsEventPublisher(queues.directory, queues.events), sent, name),
      { now: () => new Date(clock.now().getTime() + 1_000) },
      new NoopFaultInjector(),
    );
  const runUntilEmpty = async (useCase: PublishOutboxUseCase) => {
    let published = 0;
    for (;;) {
      const report = await useCase.publishDueBatch(10);
      published += report.published;
      if (report.claimed === 0) return published;
    }
  };

  const [byA, byB] = await Promise.all([
    runUntilEmpty(relay(publisherA, 'A')),
    runUntilEmpty(relay(publisherB, 'B')),
  ]);

  expect(byA + byB).toBe(WALLETS * 2);
  expect(byA).toBeGreaterThan(0); // both really competed for the same rows
  expect(byB).toBeGreaterThan(0);
  expect(sent.size).toBe(WALLETS * 2);
  for (const [, senders] of sent) {
    expect(senders).toHaveLength(1);
  }

  const owner = new SQL(db.ownerUrl, { max: 1 });
  try {
    const [row] = await owner`SELECT count(*) FILTER (WHERE published_at IS NULL)::int AS pending,
                                     count(*)::int AS total
                                FROM outbox_messages`;
    expect(row).toEqual({ pending: 0, total: WALLETS * 2 });
  } finally {
    await owner.close();
  }
  const received = await drain(sqs, await queues.url(queues.events));
  expect(new Set(received.map((message) => JSON.parse(message.Body ?? '{}').eventId)).size).toBe(
    WALLETS * 2,
  );
  await assertLedgerConsistency(db.ownerUrl);
});
