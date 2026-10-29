/**
 * The whole pipeline in one booted application with every role (APP_ROLES):
 * SQS message → consumer → PostgreSQL → outbox → events queue; plus a parked REFUND resolved
 * by the pending-reference worker, and a clean shutdown.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { type ApiHarness, getJson, ids, postJson, startApi } from '../../support/persistence';
import {
  createTestQueues,
  drain,
  messageData,
  sendMessage,
  type TestQueues,
  testSqsClient,
  wagerMessage,
} from '../../support/sqs';
import { waitFor } from '../../support/wait-for';

let db: TestDatabase;
let sqs: SQSClient;
let queues: TestQueues;
let api: ApiHarness;

beforeAll(async () => {
  db = await createTestDatabase();
  sqs = testSqsClient();
  queues = await createTestQueues(sqs);
  api = await startApi(db, {
    APP_ROLES: 'all',
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
    SQS_WAGER_TRANSACTIONS_QUEUE: queues.input,
    SQS_WAGER_TRANSACTIONS_DLQ: queues.deadLetter,
    SQS_EVENTS_QUEUE: queues.events,
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_RETRY_BASE_SECONDS: '0',
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
  });
});

afterAll(async () => {
  await api.close();
  await assertLedgerConsistency(db.ownerUrl);
  await queues.cleanup();
  sqs.destroy();
  await db.drop();
});

test('a queued BET and an out-of-order REFUND flow through to published events', async () => {
  const created = await postJson(`${api.baseUrl}/wallets`, {
    playerId: ids.next(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const wallet = { id: created.body.id as string, playerId: created.body.playerId as string };
  const inputUrl = await queues.url(queues.input);
  const betId = `bet-${ids.next()}`;

  // REFUND first, BET second: the worker must resolve the REFUND once the BET lands.
  await sendMessage(
    sqs,
    inputUrl,
    wagerMessage(messageData(wallet, 'REFUND', '40.00', { referenceExternalTransactionId: betId })),
    wallet.id,
  );
  await sendMessage(
    sqs,
    inputUrl,
    wagerMessage(messageData(wallet, 'BET', '40.00', { externalTransactionId: betId })),
    wallet.id,
  );

  const owner = new SQL(db.ownerUrl, { max: 1 });
  try {
    await waitFor(
      async () => {
        const rows: { status: string }[] = await owner`
          SELECT status FROM wager_transactions WHERE wallet_id = ${wallet.id} AND kind <> 'OPENING'`;
        return rows.length === 2 && rows.every((row) => row.status === 'PROCESSED');
      },
      { timeoutMs: 20_000, description: 'BET and REFUND processed' },
    );
    await waitFor(
      async () =>
        (await owner`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`)[0]
          .n === 0,
      { timeoutMs: 20_000, description: 'outbox drained' },
    );
  } finally {
    await owner.close();
  }

  const wallets = await getJson(`${api.baseUrl}/wallets/${wallet.id}`);
  expect(wallets.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });

  const eventTypes = (await drain(sqs, await queues.url(queues.events))).map(
    (message) => message.MessageAttributes?.eventType?.StringValue,
  );
  for (const type of [
    'WalletOpened',
    'WalletBalanceChanged',
    'WagerTransactionPendingReference',
    'WagerTransactionProcessed',
  ]) {
    expect(eventTypes).toContain(type);
  }
});
