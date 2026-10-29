/**
 * Load test (D-01, docs/LOAD_TEST.md): `bun run test:load`.
 *
 * Drives a running deployment — by default the Compose cluster (3 replicas behind nginx) — with
 * closed-loop virtual users, and reports throughput, p50/p95/p99, error rate, concurrency
 * conflicts and outbox lag per scenario. Every scenario ends with a correctness check: the
 * load is only meaningful if no money was lost or duplicated under it. The target runs with
 * AUTH_MODE=disabled: token validation is local (cached JWKS) and not what is measured here.
 *
 * Scenarios (LOAD_SCENARIOS, comma separated):
 *   uniform        many wallets, mixed BET/WIN/REFUND/ROLLBACK plus 10% client retries (replays)
 *   hot-wallet     every virtual user on one wallet: worst case of the per-wallet lock
 *   sqs-ingestion  a burst of messages on the input queue (5% duplicate sends), drained by the
 *                  consumers of every replica
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import { percentiles, Recorder, round, type ScenarioSummary } from './stats';

const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const config = {
  targetUrl: env('LOAD_TARGET_URL', 'http://localhost:8080'),
  databaseUrl: env('LOAD_DATABASE_URL', 'postgres://wallet_app:wallet_app@localhost:5432/wagering'),
  prometheusUrl: process.env.PROMETHEUS_URL || undefined,
  awsEndpoint: env('AWS_ENDPOINT_URL', 'http://localhost:4566'),
  awsRegion: env('AWS_REGION', 'us-east-1'),
  inputQueue: env('SQS_WAGER_TRANSACTIONS_QUEUE', 'wager-transactions.fifo'),
  scenarios: env('LOAD_SCENARIOS', 'uniform,hot-wallet,sqs-ingestion').split(','),
  durationSeconds: Number(env('LOAD_DURATION_SECONDS', '60')),
  warmupSeconds: Number(env('LOAD_WARMUP_SECONDS', '5')),
  virtualUsers: Number(env('LOAD_VUS', '32')),
  wallets: Number(env('LOAD_WALLETS', '500')),
  sqsMessages: Number(env('LOAD_SQS_MESSAGES', '5000')),
  sqsWallets: Number(env('LOAD_SQS_WALLETS', '200')),
};

const PROVIDER = 'load-provider';
const runId = Bun.randomUUIDv7().slice(-12);
const sql = new SQL(config.databaseUrl, { max: 4 });

// --- HTTP ---------------------------------------------------------------------------------------

interface WalletRef {
  readonly id: string;
  readonly playerId: string;
}

interface Submission {
  readonly body: Record<string, unknown>;
  readonly key: string;
}

const headers = (extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  ...extra,
});

async function createWallet(amount: string): Promise<WalletRef> {
  const response = await fetch(`${config.targetUrl}/wallets`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount, currency: 'BRL' },
    }),
  });
  if (response.status !== 201) {
    throw new Error(`wallet creation failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as WalletRef;
  return { id: body.id, playerId: body.playerId };
}

async function createWallets(count: number, amount: string): Promise<WalletRef[]> {
  const wallets: WalletRef[] = [];
  for (let i = 0; i < count; i += 20) {
    const batch = Array.from({ length: Math.min(20, count - i) }, () => createWallet(amount));
    wallets.push(...(await Promise.all(batch)));
  }
  return wallets;
}

function submission(
  wallet: WalletRef,
  kind: string,
  amount: string,
  reference?: string,
): Submission {
  const externalTransactionId = `load-${runId}-${Bun.randomUUIDv7()}`;
  return {
    key: `${PROVIDER}:${externalTransactionId}`,
    body: {
      providerId: PROVIDER,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${runId}`,
      gameId: 'load-game',
      kind,
      money: { amount, currency: 'BRL' },
      ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
    },
  };
}

interface Answer {
  readonly status: number | 'network-error';
  readonly transactionStatus?: string;
  readonly idempotentReplay?: boolean;
}

async function send(recorder: Recorder, sub: Submission, measure: boolean): Promise<Answer> {
  const started = performance.now();
  let answer: Answer;
  let code: string | undefined;
  try {
    const response = await fetch(`${config.targetUrl}/wagering/transactions`, {
      method: 'POST',
      headers: headers({ 'idempotency-key': sub.key }),
      body: JSON.stringify(sub.body),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    code = typeof body.code === 'string' ? body.code : undefined;
    answer = {
      status: response.status,
      transactionStatus: typeof body.status === 'string' ? body.status : undefined,
      idempotentReplay: body.idempotentReplay === true,
    } as Answer;
  } catch {
    answer = { status: 'network-error' };
  }
  if (measure) {
    recorder.record(answer.status, performance.now() - started, code);
  }
  return answer;
}

/** Decimal string from whole units and cents — the generator never does money arithmetic. */
const amountOf = (units: number, cents = 0) => `${units}.${String(cents).padStart(2, '0')}`;
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)] as T;

/**
 * Closed loop: each virtual user sends its next request as soon as the previous one answers.
 * Requests during the warm-up are sent but not measured.
 */
async function closedLoop(
  recorder: Recorder,
  makeUser: () => (measure: boolean) => Promise<void>,
): Promise<void> {
  const warmupEnd = performance.now() + config.warmupSeconds * 1_000;
  const end = warmupEnd + config.durationSeconds * 1_000;
  let measuring = false;
  const users = Array.from({ length: config.virtualUsers }, async () => {
    const step = makeUser();
    for (;;) {
      const now = performance.now();
      if (now >= end) return;
      if (now >= warmupEnd && !measuring) {
        measuring = true;
        recorder.startedAt = performance.now();
      }
      await step(now >= warmupEnd);
    }
  });
  await Promise.all(users);
  recorder.endedAt = performance.now();
}

// --- Database-side measurements -----------------------------------------------------------------

/** Samples the age of the oldest unpublished outbox event every second while `running`. */
function sampleOutboxLag(): { stop: () => Promise<number[]> } {
  const samples: number[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const [row] = await sql`
        SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(occurred_at)), 0)::float8 AS lag
          FROM outbox_messages WHERE published_at IS NULL`;
      samples.push(Number(row.lag));
      await Bun.sleep(1_000);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return samples;
    },
  };
}

interface OutboxReport {
  readonly events: number;
  readonly lagSamplesSeconds: { readonly p95: number; readonly max: number };
  readonly publishDelayMs: { readonly p50: number; readonly p95: number; readonly p99: number };
  readonly drainAfterLoadSeconds: number;
}

async function outboxReport(since: Date, lagSamples: number[]): Promise<OutboxReport> {
  const drainStarted = performance.now();
  for (;;) {
    const [row] = await sql`SELECT COUNT(*)::int AS n FROM outbox_messages
                             WHERE published_at IS NULL AND occurred_at >= ${since}`;
    if (row.n === 0) break;
    if (performance.now() - drainStarted > 120_000) throw new Error('outbox did not drain');
    await Bun.sleep(200);
  }
  const drainAfterLoadSeconds = round((performance.now() - drainStarted) / 1_000);
  const [delay] = await sql`
    SELECT COUNT(*)::int AS events,
           percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM published_at - occurred_at) * 1000
           )::float8[] AS p
      FROM outbox_messages WHERE occurred_at >= ${since}`;
  const [p50 = 0, p95 = 0, p99 = 0] = (delay.p ?? []) as number[];
  const lag = percentiles(lagSamples);
  return {
    events: delay.events,
    lagSamplesSeconds: { p95: lag.p95, max: lag.max },
    publishDelayMs: { p50: round(p50), p95: round(p95), p99: round(p99) },
    drainAfterLoadSeconds,
  };
}

/** balance == Σ ledger, last entry == balance/version, gapless versions — in `numeric`. */
async function inconsistentWallets(walletIds: readonly string[]): Promise<number> {
  const [row] = await sql`
    WITH checked AS (
      SELECT w.id,
             w.balance_amount = COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount
                                                             ELSE -l.amount END), 0)
               AND COUNT(l.id) = COALESCE(MAX(l.wallet_version) - MIN(l.wallet_version) + 1, 0)
               AND w.version = COALESCE(MAX(l.wallet_version), w.version) AS ok
        FROM wallets w
        LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
       WHERE w.id IN ${sql(walletIds as string[])}
       GROUP BY w.id)
    SELECT COUNT(*) FILTER (WHERE NOT ok)::int AS bad, COUNT(*)::int AS total FROM checked`;
  if (row.total !== walletIds.length) throw new Error('wallets missing from the database');
  return row.bad;
}

// --- Server-side counters (optional: profile "observability") -----------------------------------

async function serverCounters(seconds: number): Promise<Record<string, number> | undefined> {
  if (config.prometheusUrl === undefined) return undefined;
  const window = `${Math.max(1, Math.ceil(seconds))}s`;
  const queries: Record<string, string> = {
    lockConflicts: `sum(increase(db_lock_conflicts_total[${window}]))`,
    transientRetries: `sum(increase(processing_retries_total[${window}]))`,
    inboxDuplicates: `sum(increase(inbox_duplicates_total[${window}]))`,
    deadLettered: `sum(increase(sqs_dlq_messages_total[${window}]))`,
  };
  const result: Record<string, number> = {};
  for (const [name, query] of Object.entries(queries)) {
    const url = `${config.prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`;
    const body = (await (await fetch(url)).json()) as {
      data?: { result?: { value?: [number, string] }[] };
    };
    result[name] = round(Number(body.data?.result?.[0]?.value?.[1] ?? 0));
  }
  return result;
}

/**
 * Prometheus scrapes every 5s: wait for the counters of the scenario's tail to be scraped.
 * `increase()` extrapolates at the window edges, so these are approximations; the exact
 * correctness numbers come from the database.
 */
const settleScrape = () => (config.prometheusUrl ? Bun.sleep(11_000) : Promise.resolve());

// --- Scenarios ----------------------------------------------------------------------------------

interface ScenarioReport {
  readonly scenario: string;
  readonly client?: ScenarioSummary;
  readonly sqs?: Record<string, unknown>;
  readonly outbox: OutboxReport;
  readonly server: Record<string, number> | undefined;
  readonly correctness: Record<string, unknown>;
}

async function uniform(): Promise<ScenarioReport> {
  const wallets = await createWallets(config.wallets, '1000.00');
  const recorder = new Recorder();
  const since = new Date();
  const lag = sampleOutboxLag();
  await closedLoop(recorder, () => {
    const history: Submission[] = [];
    const openBets: { wallet: WalletRef; externalTransactionId: string; amount: string }[] = [];
    return async (measure) => {
      const roll = Math.random();
      if (roll < 0.1 && history.length > 0) {
        // A provider retry: identical key and body, must come back as a replay.
        const answer = await send(recorder, pick(history), measure);
        if (measure && answer.idempotentReplay) recorder.replays += 1;
        return;
      }
      let sub: Submission;
      if (roll < 0.2 && openBets.length > 0) {
        const [bet] = openBets.splice(Math.floor(Math.random() * openBets.length), 1);
        if (bet === undefined) return;
        const kind = roll < 0.15 ? 'REFUND' : 'ROLLBACK';
        sub = submission(bet.wallet, kind, bet.amount, bet.externalTransactionId);
      } else if (roll < 0.75) {
        const wallet = pick(wallets);
        const amount = amountOf(1 + Math.floor(Math.random() * 5));
        sub = submission(wallet, 'BET', amount);
        const answer = await send(recorder, sub, measure);
        if (answer.status === 200) {
          history.push(sub);
          const externalTransactionId = sub.body.externalTransactionId as string;
          openBets.push({ wallet, externalTransactionId, amount });
        }
        return;
      } else {
        sub = submission(pick(wallets), 'WIN', amountOf(1 + Math.floor(Math.random() * 9), 50));
      }
      const answer = await send(recorder, sub, measure);
      if (answer.status === 200) {
        history.push(sub);
      }
    };
  });
  const lagSamples = await lag.stop();
  const outbox = await outboxReport(since, lagSamples);
  await settleScrape();
  const client = recorder.summary();
  return {
    scenario: 'uniform',
    client,
    outbox,
    server: await serverCounters(client.durationSeconds + config.warmupSeconds + 15),
    correctness: {
      wallets: wallets.length,
      inconsistentWallets: await inconsistentWallets(wallets.map((w) => w.id)),
    },
  };
}

async function hotWallet(): Promise<ScenarioReport> {
  const [wallet] = await createWallets(1, '1000000.00');
  if (wallet === undefined) throw new Error('no wallet');
  const recorder = new Recorder();
  const since = new Date();
  const lag = sampleOutboxLag();
  // Every request moves exactly 0.01, so the expected balance is plain counting in cents.
  let netCents = 0n;
  await closedLoop(recorder, () => {
    let bet = true;
    return async (measure) => {
      const kind = bet ? 'BET' : 'WIN';
      bet = !bet;
      const answer = await send(recorder, submission(wallet, kind, '0.01'), measure);
      if (answer.status === 200 && answer.transactionStatus === 'PROCESSED') {
        netCents += kind === 'WIN' ? 1n : -1n;
      }
    };
  });
  const lagSamples = await lag.stop();
  const outbox = await outboxReport(since, lagSamples);
  await settleScrape();
  const client = recorder.summary();
  const expectedCents = 100_000_000n + netCents;
  const expected = `${expectedCents / 100n}.${String(expectedCents % 100n).padStart(2, '0')}`;
  const [row] = await sql`SELECT balance_amount::text AS balance FROM wallets
                           WHERE id = ${wallet.id}`;
  return {
    scenario: 'hot-wallet',
    client,
    outbox,
    server: await serverCounters(client.durationSeconds + config.warmupSeconds + 15),
    correctness: {
      expectedBalance: expected,
      storedBalance: row.balance,
      balanceMatchesAcknowledgedRequests: row.balance === expected,
      inconsistentWallets: await inconsistentWallets([wallet.id]),
    },
  };
}

async function sqsIngestion(): Promise<ScenarioReport> {
  const wallets = await createWallets(config.sqsWallets, '100000.00');
  const sqs = new SQSClient({
    region: config.awsRegion,
    endpoint: config.awsEndpoint,
    useQueueUrlAsEndpoint: false,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: config.inputQueue }));
  const prefix = `sqs-${runId}-`;
  // Events carry the envelope's occurredAt, so the window opens before the messages are built.
  const since = new Date();
  const entries: SendMessageBatchRequestEntry[] = [];
  for (let i = 0; i < config.sqsMessages; i++) {
    const wallet = pick(wallets);
    const externalTransactionId = `${prefix}${i}`;
    const body = JSON.stringify({
      messageId: `msg-${externalTransactionId}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: PROVIDER,
        externalTransactionId,
        idempotencyKey: `${PROVIDER}:${externalTransactionId}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: `round-${runId}`,
        gameId: 'load-game',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      },
    });
    const copies = Math.random() < 0.05 ? 2 : 1; // duplicate sends: the inbox must absorb them
    for (let copy = 0; copy < copies; copy++) {
      entries.push({
        Id: String(entries.length % 10),
        MessageBody: body,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: Bun.randomUUIDv7(),
      });
    }
  }
  const lag = sampleOutboxLag();
  const sendStarted = Date.now();
  const batches: SendMessageBatchRequestEntry[][] = [];
  for (let i = 0; i < entries.length; i += 10) {
    batches.push(entries.slice(i, i + 10).map((entry, index) => ({ ...entry, Id: String(index) })));
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        if (batch) await sqs.send(new SendMessageBatchCommand({ QueueUrl, Entries: batch }));
      }
    }),
  );
  const sendSeconds = (Date.now() - sendStarted) / 1_000;
  const deadline = Date.now() + 300_000;
  let done = 0;
  while (done < config.sqsMessages) {
    if (Date.now() > deadline) throw new Error(`only ${done}/${config.sqsMessages} processed`);
    const [row] = await sql`SELECT COUNT(*)::int AS n FROM wager_transactions
                             WHERE provider_id = ${PROVIDER}
                               AND external_transaction_id LIKE ${`${prefix}%`}
                               AND status IN ('PROCESSED', 'REJECTED', 'FAILED')`;
    done = row.n;
    if (done < config.sqsMessages) await Bun.sleep(250);
  }
  const [timing] = await sql`
    SELECT EXTRACT(EPOCH FROM MAX(processed_at) - ${new Date(sendStarted)}::timestamptz)::float8
             AS seconds,
           COUNT(*)::int AS rows,
           COUNT(*) FILTER (WHERE status = 'PROCESSED')::int AS processed,
           percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM processed_at - ${new Date(sendStarted)}::timestamptz)
           )::float8[] AS p
      FROM wager_transactions
     WHERE provider_id = ${PROVIDER} AND external_transaction_id LIKE ${`${prefix}%`}`;
  const [inbox] = await sql`SELECT COUNT(*)::int AS n FROM inbox_messages
                             WHERE message_id LIKE ${`msg-${prefix}%`}`;
  const lagSamples = await lag.stop();
  const outbox = await outboxReport(since, lagSamples);
  await settleScrape();
  const { Attributes: depth = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  sqs.destroy();
  const [p50 = 0, p95 = 0, p99 = 0] = (timing.p ?? []) as number[];
  return {
    scenario: 'sqs-ingestion',
    sqs: {
      messages: config.sqsMessages,
      sentIncludingDuplicates: entries.length,
      sendSeconds: round(sendSeconds),
      drainSeconds: round(timing.seconds),
      throughputPerSecond: round(config.sqsMessages / timing.seconds),
      completedAfterFirstSendSeconds: { p50: round(p50), p95: round(p95), p99: round(p99) },
    },
    outbox,
    server: await serverCounters(timing.seconds + 15),
    correctness: {
      uniqueTransactions: timing.rows,
      processed: timing.processed,
      oneRowPerMessageDespiteDuplicates: timing.rows === config.sqsMessages,
      inboxRows: inbox.n,
      queueLeftover: {
        visible: Number(depth.ApproximateNumberOfMessages ?? 0),
        inFlight: Number(depth.ApproximateNumberOfMessagesNotVisible ?? 0),
      },
      inconsistentWallets: await inconsistentWallets(wallets.map((w) => w.id)),
    },
  };
}

// --- Main ---------------------------------------------------------------------------------------

const scenarios: Record<string, () => Promise<ScenarioReport>> = {
  uniform,
  'hot-wallet': hotWallet,
  'sqs-ingestion': sqsIngestion,
};

const ready = await fetch(`${config.targetUrl}/health/ready`).catch(() => undefined);
if (ready?.status !== 200) {
  console.error(`${config.targetUrl} is not ready — start the cluster first (docs/LOAD_TEST.md)`);
  process.exit(1);
}

const reports: ScenarioReport[] = [];
for (const name of config.scenarios) {
  const scenario = scenarios[name.trim()];
  if (scenario === undefined) throw new Error(`unknown scenario ${name}`);
  console.error(`[load] ${name}…`);
  const report = await scenario();
  reports.push(report);
  console.log(JSON.stringify(report, null, 2));
}
await sql.close();

const failed = reports.filter(
  (r) =>
    r.correctness.inconsistentWallets !== 0 ||
    r.correctness.balanceMatchesAcknowledgedRequests === false ||
    r.correctness.oneRowPerMessageDespiteDuplicates === false ||
    (r.correctness.inboxRows !== undefined && r.correctness.inboxRows !== config.sqsMessages),
);
const output = {
  runId,
  at: new Date().toISOString(),
  config: {
    ...config,
    databaseUrl: config.databaseUrl.replace(/\/\/[^@]*@/, '//'),
  },
  reports,
};
const dir = join(import.meta.dir, 'results');
await mkdir(dir, { recursive: true });
await Bun.write(
  join(dir, `${output.at.replaceAll(':', '-')}.json`),
  JSON.stringify(output, null, 2),
);
if (failed.length > 0) {
  console.error(`[load] CORRECTNESS FAILED in ${failed.map((r) => r.scenario).join(', ')}`);
  process.exit(2);
}
