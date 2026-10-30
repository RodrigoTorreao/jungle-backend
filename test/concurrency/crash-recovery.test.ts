/**
 * T-C08 / T-I06 (Desafio.md §11 and §13): real processes die with SIGKILL at exact points and in
 * the middle of load, are restarted, and the final state is proven consistent:
 *  - instance "publisher" kills itself after the broker accepted a batch, before marking it;
 *  - instance "consumer" kills itself after COMMIT, before deleting the message;
 *  - instance "api" is SIGKILLed while HTTP requests are in flight; clients retry elsewhere.
 * Every operation must end applied exactly once and every event published.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import {
  type Instance,
  instanceEnv,
  isDead,
  killInstance,
  startInstance,
  stopInstance,
} from '../support/cluster';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertLedgerConsistency } from '../support/ledger-consistency';
import { getJson, type JsonResponse, postJson } from '../support/persistence';
import {
  createTestQueues,
  drain,
  messageData,
  queueDepth,
  sendMessage,
  type TestQueues,
  testSqsClient,
  wagerMessage,
} from '../support/sqs';
import { submission, submit, type WalletRef } from '../support/wagering';
import { waitFor } from '../support/wait-for';

const WALLETS = 20;
const QUEUED_BETS_PER_WALLET = 5; // 1.00 each, through SQS
const HTTP_BETS_PER_WALLET = 5; // 2.00 each, through HTTP

let db: TestDatabase;
let sqs: SQSClient;
let queues: TestQueues;
let owner: SQL;
const fleet: Instance[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  sqs = testSqsClient();
  queues = await createTestQueues(sqs, { visibilityTimeoutSeconds: 3, maxReceiveCount: 10 });
  owner = new SQL(db.ownerUrl, { max: 2 });
}, 60_000);

afterAll(async () => {
  await Promise.all(fleet.map(stopInstance));
  await owner.close();
  await queues.cleanup();
  sqs.destroy();
  await db.drop();
}, 60_000);

const alive = () => fleet.filter((node) => !isDead(node));

async function boot(name: string, overrides: Record<string, string> = {}) {
  const node = await startInstance(name, instanceEnv(db, queues, overrides));
  fleet.push(node);
  return node;
}

/** A provider client: on a dead instance, 503 or reset connection, retry the same request elsewhere. */
function withRetries(send: (baseUrl: string) => Promise<JsonResponse>): Promise<JsonResponse> {
  let turn = 0;
  return waitFor(
    async () => {
      const nodes = alive().filter(
        (node) => node.name.startsWith('api') || node.name.endsWith("'"),
      );
      const target = nodes[turn++ % Math.max(nodes.length, 1)];
      if (target === undefined) return false;
      const response = await send(target.baseUrl).catch(() => undefined);
      return response !== undefined && response.status < 500 ? response : false;
    },
    { timeoutMs: 90_000, intervalMs: 100, description: 'request accepted by a live instance' },
  );
}

async function settled() {
  const [row] = await owner`
    SELECT (SELECT count(*) FROM outbox_messages WHERE published_at IS NULL)::int AS outbox,
           (SELECT count(*) FROM wager_transactions WHERE status = 'PENDING_REFERENCE')::int AS pending`;
  const depth = await queueDepth(sqs, await queues.url(queues.input));
  return row.outbox === 0 && row.pending === 0 && depth.visible === 0 && depth.inFlight === 0;
}

test('SIGKILL at the crash points and mid-load, then restart: everything applied exactly once', async () => {
  // 1. Roles split so each fault point is guaranteed to fire on its own instance.
  const api = await boot('api', { APP_ROLES: 'api,pending-reference-worker' });
  const publisher = await boot('api-publisher', {
    APP_ROLES: 'api,outbox-publisher',
    FAULT_POINTS: 'after-publish-before-mark',
    FAULT_MODE: 'kill',
  });
  const consumer = await boot('consumer', {
    APP_ROLES: 'consumer',
    FAULT_POINTS: 'after-commit-before-ack',
    FAULT_MODE: 'kill',
  });

  const wallets: WalletRef[] = [];
  for (let i = 0; i < WALLETS; i++) {
    const created = await withRetries((baseUrl) =>
      postJson(`${baseUrl}/wallets`, {
        playerId: Bun.randomUUIDv7(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    );
    wallets.push({ id: created.body.id, playerId: created.body.playerId });
  }

  // 2. The publisher dies right after its first batch reached SQS; a fresh one takes over.
  await waitFor(() => isDead(publisher), { timeoutMs: 30_000, description: 'publisher killed' });
  await boot("publisher'");

  // 3. Queued bets: the consumer dies after its first COMMIT, before the ack.
  const inputUrl = await queues.url(queues.input);
  for (const wallet of wallets) {
    for (let n = 0; n < QUEUED_BETS_PER_WALLET; n++) {
      await sendMessage(sqs, inputUrl, wagerMessage(messageData(wallet, 'BET', '1.00')), wallet.id);
    }
  }
  await waitFor(() => isDead(consumer), { timeoutMs: 30_000, description: 'consumer killed' });
  await boot("consumer'");

  // 4. HTTP load; the api instance is SIGKILLed in the middle and replaced.
  let completed = 0;
  const httpLoad = wallets.flatMap((wallet) =>
    Array.from({ length: HTTP_BETS_PER_WALLET }, () => {
      const bet = submission(wallet, 'BET', '2.00');
      return withRetries((baseUrl) => submit(baseUrl, bet)).then((response) => {
        completed += 1;
        return response;
      });
    }),
  );
  await waitFor(() => completed >= 30, { timeoutMs: 60_000, description: 'load under way' });
  await killInstance(api);
  await boot("api'");
  const responses = await Promise.all(httpLoad);
  expect(responses.every((response) => response.status === 200)).toBe(true);

  // 5. Final state, once queues, outbox and workers have caught up.
  await waitFor(settled, { timeoutMs: 90_000, intervalMs: 250, description: 'system settled' });

  const expected = (100 - QUEUED_BETS_PER_WALLET * 1 - HTTP_BETS_PER_WALLET * 2).toFixed(2);
  for (const wallet of wallets) {
    const view = await getJson(`${alive()[0]?.baseUrl}/wallets/${wallet.id}`);
    expect(view.body.balance.amount).toBe(expected);
  }
  const [counts] = await owner`
    SELECT count(*) FILTER (WHERE kind = 'BET' AND status = 'PROCESSED')::int AS bets,
           count(*) FILTER (WHERE status <> 'PROCESSED')::int AS other
      FROM wager_transactions`;
  expect(counts).toEqual({
    bets: WALLETS * (QUEUED_BETS_PER_WALLET + HTTP_BETS_PER_WALLET),
    other: 0,
  });
  await assertLedgerConsistency(db.ownerUrl);

  // Nothing lost on the way out either: every committed event reached the events queue.
  const eventIds: string[] = (await owner`SELECT id FROM outbox_messages`).map(
    (row: { id: string }) => row.id,
  );
  const published = new Set(
    (await drain(sqs, await queues.url(queues.events))).map(
      (message) => JSON.parse(message.Body ?? '{}').eventId as string,
    ),
  );
  expect(eventIds.filter((id) => !published.has(id))).toEqual([]);
  expect((await queueDepth(sqs, await queues.url(queues.deadLetter))).visible).toBe(0);
  expect([publisher, consumer, api].every(isDead)).toBe(true);
}, 300_000);
