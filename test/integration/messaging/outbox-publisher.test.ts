/**
 * Transactional outbox relay against real queues (Desafio.md §11): the committed-but-unpublished
 * scenario, broker failures with retry scheduling, and a crash between publishing and marking.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import { TRUSTED } from '../../../src/application/ports/identity';
import { PublishOutboxUseCase } from '../../../src/application/use-cases/publish-outbox';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction-kind';
import { QueueDirectory } from '../../../src/infrastructure/messaging/sqs';
import { SqsEventPublisher } from '../../../src/infrastructure/messaging/sqs-event-publisher';
import {
  ArmedFaultInjector,
  NoopFaultInjector,
} from '../../../src/infrastructure/system/fault-injectors';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import {
  applyOperation,
  connectPersistence,
  ids,
  type Persistence,
} from '../../support/persistence';
import {
  createTestQueues,
  drain,
  ManualClock,
  type TestQueues,
  testSqsClient,
} from '../../support/sqs';

let db: TestDatabase;
let instanceA: Persistence; // writes the money movements
let instanceB: Persistence; // a different "instance" that only relays the outbox
let sqs: SQSClient;
let queues: TestQueues;
let owner: SQL;

beforeAll(async () => {
  db = await createTestDatabase();
  [instanceA, instanceB] = await Promise.all([connectPersistence(db), connectPersistence(db)]);
  sqs = testSqsClient();
  queues = await createTestQueues(sqs);
  owner = new SQL(db.ownerUrl, { max: 1 });
});

afterAll(async () => {
  await assertLedgerConsistency(db.ownerUrl);
  await queues.cleanup();
  sqs.destroy();
  await owner.close();
  await Promise.all([instanceA.close(), instanceB.close()]);
  await db.drop();
});

const unpublished = async () =>
  (await owner`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`)[0].n;

async function drainOutbox(useCase: PublishOutboxUseCase) {
  let total = 0;
  for (;;) {
    const report = await useCase.publishDueBatch(50);
    total += report.published;
    if (report.claimed === 0) return total;
  }
}

function relay(persistence: Persistence, overrides: { queue?: string; clock?: ManualClock } = {}) {
  return new PublishOutboxUseCase(
    persistence.unitOfWork,
    new SqsEventPublisher(queues.directory, overrides.queue ?? queues.events),
    overrides.clock ?? new ManualClock(new Date(Date.now() + 1_000)),
    new NoopFaultInjector(),
  );
}

describe('committed, then the writer died before publishing', () => {
  test('another instance publishes every event, with the envelope verbatim', async () => {
    await drainOutbox(relay(instanceB)); // start from an empty outbox
    const wallet = await instanceA.createWallet.execute({
      playerId: ids.next(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: 'corr-relay',
      principal: TRUSTED,
    });
    const { transaction } = await applyOperation(
      instanceA.unitOfWork,
      wallet.id,
      WagerTransactionKind.Bet,
      '10.00',
    );
    // applyOperation (test helper) writes no events; the wallet creation wrote two.
    expect(await unpublished()).toBe(2);

    expect(await drainOutbox(relay(instanceB))).toBe(2);
    expect(await unpublished()).toBe(0);

    const received = await drain(sqs, await queues.url(queues.events));
    const rows: { id: string; payload: unknown }[] =
      await owner`SELECT id, payload FROM outbox_messages WHERE aggregate_id = ${wallet.id}`;
    const bodies = received.map((message) => JSON.parse(message.Body ?? '{}'));
    for (const row of rows) {
      expect(bodies).toContainEqual(row.payload);
    }
    for (const message of received) {
      expect(message.Attributes?.MessageGroupId).toBe(wallet.id);
      expect(message.MessageAttributes?.correlationId?.StringValue).toBe('corr-relay');
    }
    expect(transaction.id).toBeDefined();
  });
});

describe('broker failures', () => {
  test('an unreachable queue schedules a retry with backoff; the next due run publishes', async () => {
    await drainOutbox(relay(instanceB));
    const clock = new ManualClock(new Date(Date.now() + 1_000));
    await instanceA.createWallet.execute({
      playerId: ids.next(),
      initialBalance: { amount: '5.00', currency: 'BRL' },
      correlationId: 'corr-retry',
      principal: TRUSTED,
    });

    const broken = new PublishOutboxUseCase(
      instanceB.unitOfWork,
      new SqsEventPublisher(new QueueDirectory(sqs), `missing-${ids.next()}.fifo`),
      clock,
      new NoopFaultInjector(),
    );
    expect(await broken.publishDueBatch(50)).toMatchObject({ claimed: 2, published: 0, failed: 2 });
    const pending: { attempts: number; next_attempt_at: Date; last_error: string | null }[] =
      await owner`SELECT attempts, next_attempt_at, last_error FROM outbox_messages
                   WHERE published_at IS NULL`;
    expect(pending).toHaveLength(2);
    for (const row of pending) {
      expect(row.attempts).toBe(1);
      expect(row.next_attempt_at.getTime()).toBe(clock.now().getTime() + 1_000);
      expect(row.last_error).toBeTruthy();
    }

    // Not due yet: nothing is claimed.
    expect((await relay(instanceB, { clock }).publishDueBatch(50)).claimed).toBe(0);
    clock.advance(1_000);
    expect(await drainOutbox(relay(instanceB, { clock }))).toBe(2);
    expect(await unpublished()).toBe(0);
  });
});

describe('crash between publishing and marking (after-publish-before-mark)', () => {
  test('rows stay pending and are published again with the same eventId — never lost', async () => {
    await drainOutbox(relay(instanceB));
    await drain(sqs, await queues.url(queues.events));
    const wallet = await instanceA.createWallet.execute({
      playerId: ids.next(),
      initialBalance: { amount: '7.00', currency: 'BRL' },
      correlationId: 'corr-crash',
      principal: TRUSTED,
    });
    const crashing = new PublishOutboxUseCase(
      instanceB.unitOfWork,
      new SqsEventPublisher(queues.directory, queues.events),
      new ManualClock(new Date(Date.now() + 1_000)),
      new ArmedFaultInjector(['after-publish-before-mark']),
    );
    await expect(crashing.publishDueBatch(50)).rejects.toThrow('Simulated crash');
    expect(await unpublished()).toBe(2);

    expect(await drainOutbox(relay(instanceB))).toBe(2);
    expect(await unpublished()).toBe(0);

    const eventIds: string[] = (
      await owner`SELECT id FROM outbox_messages WHERE aggregate_id = ${wallet.id}`
    ).map((row: { id: string }) => row.id);
    const received = (await drain(sqs, await queues.url(queues.events))).map(
      (message) => JSON.parse(message.Body ?? '{}').eventId,
    );
    // At-least-once: every event arrived; a second copy (if the broker kept it) has the same id.
    expect(new Set(received)).toEqual(new Set(eventIds));
  });
});
