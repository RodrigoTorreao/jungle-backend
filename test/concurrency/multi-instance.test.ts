/**
 * T-C04 (Desafio §8: "três ou mais instâncias rodam simultaneamente"): three real processes,
 * each with every role (HTTP, consumer, outbox publisher, pending-reference worker), compete
 * for the same wallets over HTTP and SQS at once.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import { type Instance, instanceEnv, startInstance, stopInstance } from '../support/cluster';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertLedgerConsistency } from '../support/ledger-consistency';
import { getJson, ids } from '../support/persistence';
import {
  createTestQueues,
  messageData,
  queueDepth,
  sendMessage,
  type TestQueues,
  testSqsClient,
  wagerMessage,
} from '../support/sqs';
import { createWallet, submission, submit, type WalletRef } from '../support/wagering';
import { waitFor } from '../support/wait-for';

let db: TestDatabase;
let sqs: SQSClient;
let queues: TestQueues;
let instances: Instance[] = [];
let owner: SQL;

beforeAll(async () => {
  db = await createTestDatabase();
  sqs = testSqsClient();
  queues = await createTestQueues(sqs, { visibilityTimeoutSeconds: 5 });
  owner = new SQL(db.ownerUrl, { max: 2 });
  instances = await Promise.all(
    ['a', 'b', 'c'].map((name) => startInstance(name, instanceEnv(db, queues))),
  );
}, 90_000);

afterAll(async () => {
  await Promise.all(instances.map(stopInstance));
  await owner.close();
  await queues.cleanup();
  sqs.destroy();
  await db.drop();
}, 60_000);

const instance = (index: number) => instances[index % instances.length] as Instance;
const balanceOf = async (wallet: WalletRef) =>
  (await getJson(`${instance(0).baseUrl}/wallets/${wallet.id}`)).body.balance.amount as string;

async function settled() {
  const [row] = await owner`
    SELECT (SELECT count(*) FROM outbox_messages WHERE published_at IS NULL)::int AS outbox,
           (SELECT count(*) FROM wager_transactions WHERE status = 'PENDING_REFERENCE')::int AS pending`;
  const depth = await queueDepth(sqs, await queues.url(queues.input));
  return row.outbox === 0 && row.pending === 0 && depth.visible === 0 && depth.inFlight === 0;
}

test('three instances: no lost update, no double effect, every event published', async () => {
  const wallets = await Promise.all(
    Array.from({ length: 30 }, (_, i) => createWallet(instance(i).baseUrl, '100.00')),
  );
  const races = wallets.slice(0, 10); // 80 + 80 on 100, each bet to a different instance
  const duplicates = wallets.slice(10, 20); // the same bet 9 times, spread over 3 instances
  const queued = wallets.slice(20, 30); // SQS: duplicated messages and REFUND before BET

  const inputUrl = await queues.url(queues.input);
  const http = [
    ...races.flatMap((wallet, i) => [
      submit(instance(i).baseUrl, submission(wallet, 'BET', '80.00')),
      submit(instance(i + 1).baseUrl, submission(wallet, 'BET', '80.00')),
    ]),
    ...duplicates.flatMap((wallet) => {
      const bet = submission(wallet, 'BET', '30.00');
      return Array.from({ length: 9 }, (_, copy) => submit(instance(copy).baseUrl, bet));
    }),
  ];
  const sqsWork = queued.map(async (wallet) => {
    const betId = `bet-${ids.next()}`;
    const refund = wagerMessage(
      messageData(wallet, 'REFUND', '40.00', { referenceExternalTransactionId: betId }),
    );
    const bet = wagerMessage(messageData(wallet, 'BET', '40.00', { externalTransactionId: betId }));
    const win = wagerMessage(messageData(wallet, 'WIN', '5.00'));
    for (const message of [refund, bet, bet, win, win]) {
      await sendMessage(sqs, inputUrl, message, wallet.id); // duplicates: same messageId twice
    }
  });
  const responses = await Promise.all(http);
  await Promise.all(sqsWork);

  // HTTP outcomes are decided synchronously.
  for (let i = 0; i < races.length; i++) {
    const pair = [responses[2 * i], responses[2 * i + 1]];
    expect(pair.map((response) => response?.status).sort()).toEqual([200, 422]);
  }
  const duplicateResponses = responses.slice(races.length * 2);
  for (let i = 0; i < duplicates.length; i++) {
    const copies = duplicateResponses.slice(i * 9, i * 9 + 9);
    expect(copies.every((response) => response.status === 200)).toBe(true);
    expect(new Set(copies.map((response) => response.body.transactionId)).size).toBe(1);
    expect(copies.filter((response) => !response.body.idempotentReplay)).toHaveLength(1);
  }

  // Queue, outbox and pending references drain across the three instances.
  await waitFor(settled, { timeoutMs: 60_000, intervalMs: 250, description: 'system settled' });

  for (const wallet of races) expect(await balanceOf(wallet)).toBe('20.00');
  for (const wallet of duplicates) expect(await balanceOf(wallet)).toBe('70.00');
  for (const wallet of queued) expect(await balanceOf(wallet)).toBe('105.00');

  const [counts] = await owner`
    SELECT count(*) FILTER (WHERE status = 'PROCESSED' AND kind <> 'OPENING')::int AS processed,
           count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
      FROM wager_transactions`;
  // races: 10 processed + 10 rejected; duplicates: 10; queued: 3 per wallet (refund, bet, win)
  expect(counts).toEqual({ processed: 10 + 10 + 30, rejected: 10 });
  await assertLedgerConsistency(db.ownerUrl);

  // The work really was shared, and the logs carry the context without amounts.
  const processedBy = instances.map(
    (node) => node.logs.filter((line) => line.msg === 'Message processed').length,
  );
  expect(processedBy.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(30);
  const messageLogs = instances.flatMap((node) =>
    node.logs.filter((line) => line.msg === 'Message processed'),
  );
  for (const line of messageLogs) {
    expect(line).toMatchObject({
      correlationId: expect.any(String),
      messageId: expect.any(String),
      transactionId: expect.any(String),
      walletId: expect.any(String),
      providerId: 'provider-a',
    });
  }
  const everyLine = JSON.stringify(instances.flatMap((node) => node.logs));
  expect(everyLine).not.toMatch(/"amount":"\d/);
  console.info(`SQS messages processed per instance: ${processedBy.join(' / ')}`);
}, 120_000);
