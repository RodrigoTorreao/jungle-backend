/**
 * Operational endpoints (Desafio §9, §12): readiness, the Prometheus catalogue of
 * ARCHITECTURE §10 with values produced by real requests, and readiness during shutdown.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { ReadinessProbe } from '../../../src/infrastructure/observability/readiness';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { type ApiHarness, getJson, startApi } from '../../support/persistence';
import { createWallet, submission, submit } from '../../support/wagering';
import { deferred } from '../../support/wait-for';

let db: TestDatabase;
let api: ApiHarness;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await startApi(db);
});

afterAll(async () => {
  await assertLedgerConsistency(db.ownerUrl);
  await api.close();
  await db.drop();
});

async function scrape(baseUrl = api.baseUrl): Promise<string> {
  const response = await fetch(`${baseUrl}/metrics`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/plain');
  return response.text();
}

/** Value of one sample, e.g. sample(text, 'wagering_transactions_total', {kind: 'BET'}). */
function sample(
  text: string,
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const match = line.match(/^([a-z_]+)(\{([^}]*)\})? (.+)$/);
    if (!match || match[1] !== name) continue;
    const present = Object.fromEntries(
      (match[3] ?? '')
        .split(',')
        .filter(Boolean)
        .map((pair) => {
          const [key, value] = pair.split('=');
          return [key, value?.replaceAll('"', '')];
        }),
    );
    if (Object.entries(labels).every(([key, value]) => present[key] === value)) {
      return Number(match[4]);
    }
  }
  return undefined;
}

describe('GET /health/ready', () => {
  test('ready when PostgreSQL and every queue answer', async () => {
    const response = await getJson(`${api.baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready', checks: { database: 'up', sqs: 'up' } });
  });
});

describe('GET /metrics', () => {
  test('exposes the whole catalogue of ARCHITECTURE §10', async () => {
    const text = await scrape();
    for (const name of [
      'wagering_transactions_total',
      'wagering_processing_duration_seconds',
      'wagering_idempotent_replays_total',
      'wagering_idempotency_conflicts_total',
      'inbox_duplicates_total',
      'processing_retries_total',
      'db_lock_conflicts_total',
      'sqs_dlq_messages_total',
      'sqs_dlq_depth',
      'outbox_pending_messages',
      'outbox_lag_seconds',
      'outbox_publish_total',
      'pending_reference_transactions',
      'wallet_reconciliation_divergences_total',
    ]) {
      expect(text).toContain(`# TYPE ${name} `);
    }
  });

  test('counts outcomes, replays, conflicts and durations of real submissions', async () => {
    const before = await scrape();
    const wallet = await createWallet(api.baseUrl, '50.00');
    const bet = submission(wallet, 'BET', '10.00');
    await submit(api.baseUrl, bet); // processed
    await submit(api.baseUrl, bet); // replay
    await submit(api.baseUrl, { ...bet, money: { amount: '11.00', currency: 'BRL' } }); // conflict
    await submit(api.baseUrl, submission(wallet, 'BET', '999.00')); // rejected
    const after = await scrape();

    const delta = (name: string, labels: Record<string, string>) =>
      (sample(after, name, labels) ?? 0) - (sample(before, name, labels) ?? 0);
    const http = { source: 'http' };
    expect(
      delta('wagering_transactions_total', { kind: 'BET', status: 'PROCESSED', ...http }),
    ).toBe(1);
    expect(delta('wagering_transactions_total', { kind: 'BET', status: 'REJECTED', ...http })).toBe(
      1,
    );
    expect(delta('wagering_idempotent_replays_total', http)).toBe(1);
    expect(delta('wagering_idempotency_conflicts_total', http)).toBe(1);
    expect(
      delta('wagering_processing_duration_seconds_count', {
        kind: 'BET',
        outcome: 'processed',
        ...http,
      }),
    ).toBe(1);
    expect(sample(after, 'outbox_pending_messages')).toBeGreaterThanOrEqual(4);
    expect(sample(after, 'outbox_lag_seconds')).toBeGreaterThanOrEqual(0);
    expect(sample(after, 'pending_reference_transactions')).toBe(0);
    expect(sample(after, 'sqs_dlq_depth', { queue: 'wager-transactions-dlq.fifo' })).toBeDefined();
  });

  test('lock timeouts are counted as lock conflicts and retries', async () => {
    const impatient = await startApi(db, { DATABASE_LOCK_TIMEOUT_MS: '100' });
    const wallet = await createWallet(impatient.baseUrl, '50.00');
    const owner = new SQL(db.ownerUrl, { max: 1 });
    const locked = deferred();
    const release = deferred();
    const holder = owner.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      const response = await submit(impatient.baseUrl, submission(wallet, 'BET', '1.00'));
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      expect(response.body).toMatchObject({ code: 'LOCK_TIMEOUT', retryable: true });

      const text = await scrape(impatient.baseUrl);
      expect(sample(text, 'db_lock_conflicts_total', { type: 'lock_timeout' })).toBe(3);
      expect(sample(text, 'processing_retries_total', { reason: 'lock_timeout' })).toBe(2);
    } finally {
      release.resolve();
      await holder;
      await owner.close();
      await impatient.close();
    }
  });
});

describe('readiness during shutdown', () => {
  test('reports shutting-down (503) once the shutdown hooks start', async () => {
    api.app.get(ReadinessProbe).onModuleDestroy();
    const response = await getJson(`${api.baseUrl}/health/ready`);
    expect(response.status).toBe(503);
    expect(response.body.status).toBe('shutting-down');
    expect((await getJson(`${api.baseUrl}/health/live`)).status).toBe(200);
  });
});
