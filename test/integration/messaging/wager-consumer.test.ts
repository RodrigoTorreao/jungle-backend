/**
 * SQS consumer against real LocalStack queues and a real PostgreSQL (Desafio §10, §13):
 * inbox and redelivery (T-I03), retry and DLQ (T-I05), atomicity under an injected failure
 * (T-I02), and a crash after COMMIT but before the ack (T-C05).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import { ArmedFaultInjector } from '../../../src/infrastructure/system/fault-injectors';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { connectPersistence, ids, type Persistence } from '../../support/persistence';
import {
  buildConsumer,
  createTestQueues,
  drain,
  messageData,
  queueDepth,
  sendMessage,
  type TestQueues,
  testSqsClient,
  wagerMessage,
} from '../../support/sqs';
import { deferred, waitFor } from '../../support/wait-for';

let db: TestDatabase;
let persistence: Persistence;
let sqs: SQSClient;
let queues: TestQueues;
let owner: SQL;

beforeAll(async () => {
  db = await createTestDatabase();
  persistence = await connectPersistence(db);
  sqs = testSqsClient();
  queues = await createTestQueues(sqs, { maxReceiveCount: 3, visibilityTimeoutSeconds: 2 });
  owner = new SQL(db.ownerUrl, { max: 2 });
});

afterAll(async () => {
  await assertLedgerConsistency(db.ownerUrl);
  await queues.cleanup();
  sqs.destroy();
  await owner.close();
  await persistence.close();
  await db.drop();
});

const newWallet = async (amount = '100.00') => {
  const view = await persistence.createWallet.execute({
    playerId: ids.next(),
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'test',
  });
  return { id: view.id, playerId: view.playerId };
};
const send = async (body: unknown, group: string) =>
  sendMessage(sqs, await queues.url(queues.input), body, group);
const balance = async (walletId: string) =>
  (await persistence.reader.findWallet(walletId))?.balance.toJSON().amount;
const transactionsOf = async (externalTransactionId: string) =>
  owner`SELECT status, failure_code FROM wager_transactions
         WHERE external_transaction_id = ${externalTransactionId}`;
const inboxRows = async (messageId: string) =>
  (await owner`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = ${messageId}`)[0].n;

describe('happy path', () => {
  test('a message is processed through the same use case, recorded in the inbox and acked', async () => {
    const wallet = await newWallet('100.00');
    const message = wagerMessage(messageData(wallet, 'BET', '25.00'));
    await send(message, wallet.id);

    expect(await buildConsumer(persistence, queues).pollOnce()).toEqual(['acked']);
    expect(await transactionsOf(message.data.externalTransactionId as string)).toEqual([
      { status: 'PROCESSED', failure_code: null },
    ]);
    expect(await inboxRows(message.messageId)).toBe(1);
    expect(await balance(wallet.id)).toBe('75.00');
    expect(await queueDepth(sqs, await queues.url(queues.input))).toEqual({
      visible: 0,
      inFlight: 0,
    });
  });

  test('a business rejection is an outcome, not a failure: acked, never dead-lettered', async () => {
    const wallet = await newWallet('10.00');
    const message = wagerMessage(messageData(wallet, 'BET', '50.00'));
    await send(message, wallet.id);

    expect(await buildConsumer(persistence, queues).pollOnce()).toEqual(['acked']);
    expect(await transactionsOf(message.data.externalTransactionId as string)).toEqual([
      { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' },
    ]);
  });

  test('messages of one wallet are applied in FIFO order', async () => {
    const wallet = await newWallet('100.00');
    const first = wagerMessage(messageData(wallet, 'BET', '80.00'));
    const second = wagerMessage(messageData(wallet, 'BET', '80.00'));
    await send(first, wallet.id);
    await send(second, wallet.id);

    const outcomes = await buildConsumer(persistence, queues).pollOnce();
    expect(outcomes).toEqual(['acked', 'acked']);
    expect((await transactionsOf(first.data.externalTransactionId as string))[0].status).toBe(
      'PROCESSED',
    );
    expect((await transactionsOf(second.data.externalTransactionId as string))[0]).toEqual({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
  });
});

describe('inbox and redelivery (T-I03)', () => {
  test('the same message delivered twice has exactly one effect', async () => {
    const wallet = await newWallet('100.00');
    const message = wagerMessage(messageData(wallet, 'BET', '10.00'));
    await send(message, wallet.id);
    await send(message, wallet.id); // a second copy: new SQS id, same body messageId

    const consumer = buildConsumer(persistence, queues);
    const outcomes = [...(await consumer.pollOnce()), ...(await consumer.pollOnce())];
    expect(outcomes).toEqual(['acked', 'acked']);
    expect(await inboxRows(message.messageId)).toBe(1);
    expect(await transactionsOf(message.data.externalTransactionId as string)).toHaveLength(1);
    expect(await balance(wallet.id)).toBe('90.00');
  });

  test('another messageId for the same operation is an idempotent replay', async () => {
    const wallet = await newWallet('100.00');
    const data = messageData(wallet, 'BET', '10.00');
    await send(wagerMessage(data), wallet.id);
    await send(wagerMessage(data), wallet.id);

    const consumer = buildConsumer(persistence, queues);
    expect([...(await consumer.pollOnce()), ...(await consumer.pollOnce())]).toEqual([
      'acked',
      'acked',
    ]);
    expect(await transactionsOf(data.externalTransactionId as string)).toHaveLength(1);
    expect(await balance(wallet.id)).toBe('90.00');
  });
});

describe('permanent failures go to the DLQ with a reason', () => {
  async function deadLetters() {
    return drain(sqs, await queues.url(queues.deadLetter));
  }

  test('malformed messages', async () => {
    await send('{"messageId": "broken"', 'garbage');
    await send(
      { messageId: 'x', type: 'Unknown', occurredAt: new Date().toISOString(), data: {} },
      'garbage',
    );

    expect(await buildConsumer(persistence, queues).pollOnce()).toEqual([
      'dead-lettered',
      'dead-lettered',
    ]);
    const dlq = await deadLetters();
    expect(dlq.map((m) => m.MessageAttributes?.failureCode?.StringValue)).toEqual([
      'INVALID_MESSAGE',
      'INVALID_MESSAGE',
    ]);
    expect(dlq[0]?.Body).toBe('{"messageId": "broken"');
    expect(await queueDepth(sqs, await queues.url(queues.input))).toEqual({
      visible: 0,
      inFlight: 0,
    });
  });

  test('an unknown wallet (nothing can be persisted, I-04)', async () => {
    const message = wagerMessage(
      messageData({ id: ids.next(), playerId: ids.next() }, 'BET', '1.00'),
    );
    await send(message, message.data.walletId);

    expect(await buildConsumer(persistence, queues).pollOnce()).toEqual(['dead-lettered']);
    const [dead] = await deadLetters();
    expect(dead?.MessageAttributes?.failureCode?.StringValue).toBe('WALLET_NOT_FOUND');
    expect(await inboxRows(message.messageId)).toBe(0);
  });

  test('a messageId reused with another payload (I-10); the first effect stays', async () => {
    const wallet = await newWallet('100.00');
    const original = wagerMessage(messageData(wallet, 'BET', '10.00'));
    const impostor = wagerMessage(messageData(wallet, 'BET', '99.00'), {
      messageId: original.messageId,
    });
    await send(original, wallet.id);
    await send(impostor, wallet.id);

    const consumer = buildConsumer(persistence, queues);
    expect([...(await consumer.pollOnce()), ...(await consumer.pollOnce())]).toEqual([
      'acked',
      'dead-lettered',
    ]);
    const [dead] = await deadLetters();
    expect(dead?.MessageAttributes?.failureCode?.StringValue).toBe('INBOX_PAYLOAD_MISMATCH');
    expect(await balance(wallet.id)).toBe('90.00');
  });

  test('an OPENING submitted by a provider', async () => {
    const wallet = await newWallet('100.00');
    await send(wagerMessage(messageData(wallet, 'OPENING', '10.00')), wallet.id);
    expect(await buildConsumer(persistence, queues).pollOnce()).toEqual(['dead-lettered']);
    const [dead] = await deadLetters();
    expect(dead?.MessageAttributes?.failureCode?.StringValue).toBe('UNSUPPORTED_KIND');
  });
});

describe('transient failures (T-I05)', () => {
  /** Holds the wallet row lock from another connection until released. */
  async function holdWalletLock(walletId: string) {
    const locked = deferred();
    const release = deferred();
    const holder = owner.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    return async () => {
      release.resolve();
      await holder;
    };
  }

  test('a lock timeout is retried later, not dead-lettered, and then applied once', async () => {
    const wallet = await newWallet('100.00');
    const message = wagerMessage(messageData(wallet, 'BET', '10.00'));
    await send(message, wallet.id);
    const impatient = await connectPersistence(db, { lockTimeoutMs: 100 });
    const consumer = buildConsumer(impatient, queues);
    const release = await holdWalletLock(wallet.id);
    try {
      expect(await consumer.pollOnce()).toEqual(['retry-scheduled']);
      expect(await transactionsOf(message.data.externalTransactionId as string)).toHaveLength(0);
    } finally {
      await release();
    }
    expect(await waitFor(() => consumer.pollOnce().then((o) => o.length > 0 && o))).toEqual([
      'acked',
    ]);
    expect(await balance(wallet.id)).toBe('90.00');
    await impatient.close();
  });

  test('after maxReceiveCount transient failures the redrive policy moves it to the DLQ', async () => {
    const wallet = await newWallet('100.00');
    const message = wagerMessage(messageData(wallet, 'BET', '10.00'));
    await send(message, wallet.id);
    const impatient = await connectPersistence(db, { lockTimeoutMs: 100 });
    const consumer = buildConsumer(impatient, queues);
    const release = await holdWalletLock(wallet.id);
    try {
      const attempts: string[] = [];
      await waitFor(
        async () => {
          attempts.push(...(await consumer.pollOnce()));
          const dlq = await queueDepth(sqs, await queues.url(queues.deadLetter));
          return dlq.visible === 1;
        },
        { timeoutMs: 30_000, description: 'redrive to the DLQ' },
      );
      expect(attempts).toEqual(['retry-scheduled', 'retry-scheduled', 'retry-scheduled']);
    } finally {
      await release();
      await impatient.close();
    }
    const [dead] = await drain(sqs, await queues.url(queues.deadLetter));
    expect(JSON.parse(dead?.Body ?? '{}').messageId).toBe(message.messageId);
    expect(await balance(wallet.id)).toBe('100.00');
  });
});

describe('injected crashes', () => {
  test('T-I02: a failure right before COMMIT leaves nothing behind — not even the inbox row', async () => {
    const wallet = await newWallet('100.00');
    const message = wagerMessage(messageData(wallet, 'BET', '10.00'));
    await send(message, wallet.id);
    const faults = new ArmedFaultInjector(['before-commit']);
    const crashing = await connectPersistence(db, { faults });

    expect(await buildConsumer(crashing, queues).pollOnce()).toEqual(['crashed']);
    await crashing.close();
    expect(await transactionsOf(message.data.externalTransactionId as string)).toHaveLength(0);
    expect(await inboxRows(message.messageId)).toBe(0);
    const [outbox] = await owner`SELECT count(*)::int AS n FROM outbox_messages
                                  WHERE payload->'data'->>'walletId' = ${wallet.id}
                                    AND event_type <> 'WalletOpened'
                                    AND payload->'data'->>'direction' IS DISTINCT FROM 'CREDIT'`;
    expect(outbox.n).toBe(0);
    expect(await balance(wallet.id)).toBe('100.00');

    // The message was never acked: once visible again it is applied exactly once.
    const consumer = buildConsumer(persistence, queues);
    expect(
      await waitFor(() => consumer.pollOnce().then((o) => o.length > 0 && o), {
        timeoutMs: 10_000,
      }),
    ).toEqual(['acked']);
    expect(await balance(wallet.id)).toBe('90.00');
  });

  test('T-C05: dying after COMMIT and before the ack never applies the message twice', async () => {
    const wallet = await newWallet('100.00');
    const message = wagerMessage(messageData(wallet, 'BET', '10.00'));
    await send(message, wallet.id);
    const faults = new ArmedFaultInjector(['after-commit-before-ack']);

    expect(await buildConsumer(persistence, queues, { faults }).pollOnce()).toEqual(['crashed']);
    expect(await balance(wallet.id)).toBe('90.00'); // committed…
    expect((await queueDepth(sqs, await queues.url(queues.input))).inFlight).toBe(1); // …not acked

    // Visibility timeout expires → redelivery → inbox duplicate → replay → ack.
    const survivor = buildConsumer(persistence, queues);
    expect(
      await waitFor(() => survivor.pollOnce().then((o) => o.length > 0 && o), {
        timeoutMs: 10_000,
      }),
    ).toEqual(['acked']);
    expect(await balance(wallet.id)).toBe('90.00');
    expect(await transactionsOf(message.data.externalTransactionId as string)).toHaveLength(1);
    expect(await inboxRows(message.messageId)).toBe(1);
    expect(await queueDepth(sqs, await queues.url(queues.input))).toEqual({
      visible: 0,
      inFlight: 0,
    });
  });
});

describe('graceful shutdown (RF-Q06)', () => {
  test('stop() aborts the long poll promptly', async () => {
    const consumer = buildConsumer(persistence, queues, { overrides: { waitTimeSeconds: 20 } });
    consumer.start();
    await waitFor(() => consumer.receiving, { description: 'consumer inside the 20s long poll' });
    const startedAt = performance.now();
    await consumer.stop();
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });

  test('in-flight work finishes; messages not started yet are released', async () => {
    const wallet = await newWallet('100.00');
    const first = wagerMessage(messageData(wallet, 'BET', '10.00'));
    const second = wagerMessage(messageData(wallet, 'BET', '20.00'));
    await send(first, wallet.id);
    await send(second, wallet.id);

    const locked = deferred();
    const release = deferred();
    const holder = owner.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const consumer = buildConsumer(persistence, queues);
    consumer.start();
    const inputUrl = await queues.url(queues.input);
    await waitFor(async () => (await queueDepth(sqs, inputUrl)).inFlight === 2, {
      description: 'both messages received, the first blocked on the wallet lock',
    });
    const stopping = consumer.stop();
    release.resolve();
    await holder;
    await stopping;

    expect((await transactionsOf(first.data.externalTransactionId as string))[0]?.status).toBe(
      'PROCESSED',
    );
    expect(await transactionsOf(second.data.externalTransactionId as string)).toHaveLength(0);
    await waitFor(async () => (await queueDepth(sqs, inputUrl)).visible === 1, {
      description: 'the unstarted message is visible again',
    });
    // Picked up again by the next consumer run.
    const next = buildConsumer(persistence, queues);
    expect(await next.pollOnce()).toEqual(['acked']);
    expect(await balance(wallet.id)).toBe('70.00');
  });
});
