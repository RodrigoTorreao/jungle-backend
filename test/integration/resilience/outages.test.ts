/**
 * Dependency outages (Desafio §3: "PostgreSQL e SQS podem ficar temporariamente
 * indisponíveis"; S5-05). A TCP proxy in front of each dependency is cut and restored, which is
 * exactly what the drivers see in a real outage: reset connections, then refused ones.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { PublishOutboxUseCase } from '../../../src/application/use-cases/publish-outbox';
import { createSqsClient, QueueDirectory } from '../../../src/infrastructure/messaging/sqs';
import { SqsEventPublisher } from '../../../src/infrastructure/messaging/sqs-event-publisher';
import { NoopFaultInjector } from '../../../src/infrastructure/system/fault-injectors';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import {
  type ApiHarness,
  connectPersistence,
  getJson,
  ids,
  type Persistence,
  startApi,
} from '../../support/persistence';
import {
  buildConsumer,
  createTestQueues,
  drain,
  ManualClock,
  messageData,
  sendMessage,
  type TestQueues,
  testSqsClient,
  wagerMessage,
} from '../../support/sqs';
import { TcpProxy } from '../../support/tcp-proxy';
import { createWallet, submission, submit } from '../../support/wagering';
import { waitFor } from '../../support/wait-for';

const LOCALSTACK = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

let db: TestDatabase;
let pg: TcpProxy;
let broker: TcpProxy;
let sqs: SQSClient;
let queues: TestQueues;
let api: ApiHarness;
let persistence: Persistence; // through the PostgreSQL proxy

beforeAll(async () => {
  db = await createTestDatabase();
  const database = new URL(db.appUrl);
  pg = await TcpProxy.create({ host: database.hostname, port: Number(database.port || 5432) });
  const localstack = new URL(LOCALSTACK);
  broker = await TcpProxy.create({ host: localstack.hostname, port: Number(localstack.port) });
  sqs = testSqsClient();
  queues = await createTestQueues(sqs);
  api = await startApi(db, {
    DATABASE_URL: pg.wrap(db.appUrl),
    AWS_ENDPOINT_URL: broker.wrap(LOCALSTACK),
    SQS_WAGER_TRANSACTIONS_QUEUE: queues.input,
    SQS_WAGER_TRANSACTIONS_DLQ: queues.deadLetter,
    SQS_EVENTS_QUEUE: queues.events,
  });
  persistence = await connectPersistence({ ...db, appUrl: pg.wrap(db.appUrl) });
});

afterAll(async () => {
  await pg.start().catch(() => {});
  await broker.start().catch(() => {});
  await assertLedgerConsistency(db.ownerUrl);
  await persistence.close();
  await api.close();
  await queues.cleanup();
  sqs.destroy();
  await pg.stop();
  await broker.stop();
  await db.drop();
}, 30_000);

const ready = () => getJson(`${api.baseUrl}/health/ready`);

describe('PostgreSQL unavailable', () => {
  test('HTTP answers 503 + Retry-After, readiness drops, and the retried request applies once', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const bet = submission(wallet, 'BET', '10.00');

    await pg.stop();
    try {
      const during = await submit(api.baseUrl, bet);
      expect(during.status).toBe(503);
      expect(during.headers.get('retry-after')).toBe('1');
      expect(during.body).toMatchObject({ code: 'DATABASE_UNAVAILABLE', retryable: true });
      expect((await ready()).body).toMatchObject({
        status: 'not-ready',
        checks: { database: 'down' },
      });
    } finally {
      await pg.start();
    }

    await waitFor(async () => (await ready()).status === 200, { description: 'ready again' });
    const after = await submit(api.baseUrl, bet);
    expect(after.status).toBe(200);
    expect(after.body.idempotentReplay).toBe(false); // nothing was committed during the outage
    expect((await submit(api.baseUrl, bet)).body.idempotentReplay).toBe(true);
    expect((await getJson(`${api.baseUrl}/wallets/${wallet.id}`)).body.balance.amount).toBe(
      '90.00',
    );
  });

  test('the consumer keeps the message (no ack) and applies it once after recovery', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const message = wagerMessage(messageData(wallet, 'BET', '25.00'));
    await sendMessage(sqs, await queues.url(queues.input), message, wallet.id);
    const consumer = buildConsumer(persistence, queues);

    await pg.stop();
    try {
      expect(await consumer.pollOnce()).toEqual(['retry-scheduled']);
    } finally {
      await pg.start();
    }
    expect(
      await waitFor(() => consumer.pollOnce().then((outcomes) => outcomes.length > 0 && outcomes), {
        timeoutMs: 15_000,
      }),
    ).toEqual(['acked']);
    expect((await getJson(`${api.baseUrl}/wallets/${wallet.id}`)).body.balance.amount).toBe(
      '75.00',
    );
  });
});

describe('connection pool after outages (regression, DECISION_LOG DL-020)', () => {
  test('a transaction whose BEGIN hits a dead socket does not leak its pool slot', async () => {
    // One connection only: a single leaked slot would make every later transaction hang.
    const single = await connectPersistence({ ...db, appUrl: pg.wrap(db.appUrl) }, { poolMax: 1 });
    const transaction = () =>
      single.unitOfWork.run(async (scope) => scope.wallets.lockForUpdate(ids.next()));
    const within = <T>(work: Promise<T>, ms: number) =>
      Promise.race([work, Bun.sleep(ms).then(() => 'HUNG' as const)]);
    try {
      await transaction();
      for (let outage = 0; outage < 3; outage++) {
        await pg.stop();
        await transaction().catch(() => {});
        await pg.start();
      }
      expect(
        await within(
          transaction().then(() => 'ok'),
          5_000,
        ),
      ).toBe('ok');
    } finally {
      expect(
        await within(
          single.close().then(() => 'closed'),
          5_000,
        ),
      ).toBe('closed');
    }
  });
});

describe('SQS unavailable', () => {
  test('HTTP keeps working, the outbox accumulates, and it drains when the broker is back', async () => {
    const proxiedSqs = createSqsClient({
      region: 'us-east-1',
      endpointUrl: broker.wrap(LOCALSTACK),
    });
    const relayAt = (clock: ManualClock) =>
      new PublishOutboxUseCase(
        persistence.unitOfWork,
        new SqsEventPublisher(new QueueDirectory(proxiedSqs), queues.events),
        clock,
        new NoopFaultInjector(),
      );
    // Start from an empty outbox.
    const warmUp = relayAt(new ManualClock(new Date(Date.now() + 1_000)));
    while ((await warmUp.publishDueBatch(100)).claimed > 0) {}
    await drain(sqs, await queues.url(queues.events));

    await broker.stop();
    let created: { id: string } | undefined;
    let clock = new ManualClock();
    try {
      created = await createWallet(api.baseUrl, '30.00'); // HTTP does not need the broker
      clock = new ManualClock(new Date(Date.now() + 1_000));
      expect(await relayAt(clock).publishDueBatch(100)).toMatchObject({ claimed: 2, published: 0 });
      expect((await ready()).body).toMatchObject({ status: 'not-ready', checks: { sqs: 'down' } });
    } finally {
      await broker.start();
    }

    clock.advance(1_000); // past the first backoff step
    expect(await relayAt(clock).publishDueBatch(100)).toMatchObject({ claimed: 2, published: 2 });
    const events = await drain(sqs, await queues.url(queues.events));
    expect(events.map((event) => event.Attributes?.MessageGroupId)).toEqual([
      created?.id,
      created?.id,
    ]);
    proxiedSqs.destroy();
    expect(ids).toBeDefined();
  });
});
