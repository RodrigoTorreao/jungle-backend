/**
 * S5-08 / RNF-07: graceful shutdown on a real SIGTERM (Desafio §10: "em SIGTERM, concluir
 * mensagens em andamento ou devolver a visibilidade"). POSIX signals only exist on Linux and
 * macOS — on Windows a "SIGTERM" is a hard kill — so this runs in CI and in Linux containers.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import { type Instance, instanceEnv, startInstance, stopInstance } from '../support/cluster';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertLedgerConsistency } from '../support/ledger-consistency';
import {
  createTestQueues,
  messageData,
  queueDepth,
  sendMessage,
  type TestQueues,
  testSqsClient,
  wagerMessage,
} from '../support/sqs';
import { createWallet } from '../support/wagering';
import { deferred, waitFor } from '../support/wait-for';

const posix = process.platform !== 'win32';

let db: TestDatabase;
let sqs: SQSClient;
let queues: TestQueues;
let owner: SQL;
let node: Instance | undefined;

beforeAll(async () => {
  db = await createTestDatabase();
  sqs = testSqsClient();
  queues = await createTestQueues(sqs, { visibilityTimeoutSeconds: 30 });
  owner = new SQL(db.ownerUrl, { max: 2 });
}, 60_000);

afterAll(async () => {
  if (node) await stopInstance(node);
  await owner.close();
  await queues.cleanup();
  sqs.destroy();
  await db.drop();
}, 60_000);

test.skipIf(!posix)(
  'SIGTERM: readiness drops, in-flight work completes and is acked, unstarted work is released',
  async () => {
    node = await startInstance(
      'graceful',
      instanceEnv(db, queues, { DATABASE_LOCK_TIMEOUT_MS: '30000', SQS_WAIT_TIME_SECONDS: '5' }),
    );
    const instance = node;
    const wallet = await createWallet(instance.baseUrl, '100.00');
    const inputUrl = await queues.url(queues.input);
    const first = wagerMessage(messageData(wallet, 'BET', '10.00'));
    const second = wagerMessage(messageData(wallet, 'BET', '20.00'));

    // Keep the first message in flight: its transaction waits on the wallet lock.
    const locked = deferred();
    const release = deferred();
    const holder = owner.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    await sendMessage(sqs, inputUrl, first, wallet.id);
    await sendMessage(sqs, inputUrl, second, wallet.id);
    await waitFor(async () => (await queueDepth(sqs, inputUrl)).inFlight === 2, {
      timeoutMs: 20_000,
      description: 'both messages received, the first blocked on the lock',
    });

    instance.process.kill('SIGTERM');
    await waitFor(
      async () => {
        const response = await fetch(`${instance.baseUrl}/health/ready`).catch(() => undefined);
        return (
          response?.status === 503 &&
          ((await response.json()) as { status: string }).status === 'shutting-down'
        );
      },
      { timeoutMs: 10_000, description: 'readiness reports shutting-down' },
    );
    expect(instance.process.exitCode).toBeNull(); // still draining

    release.resolve();
    await holder;
    await Promise.race([
      instance.exited,
      Bun.sleep(15_000).then(() => {
        throw new Error('instance did not exit within the grace period');
      }),
    ]);

    const statuses = async (externalTransactionId: unknown) =>
      (
        await owner`SELECT status FROM wager_transactions
                     WHERE external_transaction_id = ${externalTransactionId as string}`
      ).map((row: { status: string }) => row.status);
    expect(await statuses(first.data.externalTransactionId)).toEqual(['PROCESSED']);
    expect(await statuses(second.data.externalTransactionId)).toEqual([]);
    // The finished message was acked; the unstarted one went back to the queue.
    await waitFor(
      async () => {
        const depth = await queueDepth(sqs, inputUrl);
        return depth.visible === 1 && depth.inFlight === 0;
      },
      { timeoutMs: 10_000, description: 'only the unstarted message is left, visible' },
    );
    await assertLedgerConsistency(db.ownerUrl);
  },
  90_000,
);
