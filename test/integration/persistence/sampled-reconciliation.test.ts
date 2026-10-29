/**
 * S6-04 / D-07: the periodic reconciliation samples wallets (recently changed first), runs the
 * same read-only comparison as POST /wallets/:id/reconciliation and reports — never fixes —
 * what diverges. Divergence is produced the only way it can be: a superuser bypassing triggers.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { TRUSTED } from '../../../src/application/ports/identity';
import {
  type AppLogger,
  type Metrics,
  noopMetrics,
} from '../../../src/application/ports/observability';
import { ReconcileSampleUseCase } from '../../../src/application/use-cases/reconcile-sample';
import { ReconcileWalletUseCase } from '../../../src/application/use-cases/reconcile-wallet';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction-kind';
import { MikroOrmReconciliationReader } from '../../../src/infrastructure/persistence/repositories';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import {
  applyOperation,
  connectPersistence,
  ids,
  type Persistence,
} from '../../support/persistence';
import { ManualClock } from '../../support/sqs';
import { testEnv, withDatabase } from '../../support/test-env';

let db: TestDatabase;
let persistence: Persistence;
let admin: SQL;
const checks: { trigger: string; consistent: boolean }[] = [];
const errors: Record<string, unknown>[] = [];

const logger: AppLogger = {
  info: () => {},
  warn: () => {},
  error: (context) => errors.push(context),
};
const metrics: Metrics = {
  ...noopMetrics,
  reconciliationCheck: (trigger, consistent) => checks.push({ trigger, consistent }),
};

beforeAll(async () => {
  db = await createTestDatabase();
  persistence = await connectPersistence(db);
  admin = new SQL(withDatabase(testEnv.adminUrl, db.name), { max: 1 });
});

afterAll(async () => {
  await assertLedgerConsistency(db.ownerUrl);
  await admin.close();
  await persistence.close();
  await db.drop();
});

const newWallet = async (amount: string) =>
  (
    await persistence.createWallet.execute({
      playerId: ids.next(),
      initialBalance: { amount, currency: 'BRL' },
      correlationId: 'test',
      principal: TRUSTED,
    })
  ).id;

/** A superuser's session with triggers off: the only way past the schema guarantees. */
const bypass = (work: (tx: SQL) => Promise<unknown>) =>
  admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await work(tx);
  });

const sampler = (clock: ManualClock, sampleSize: number) =>
  new ReconcileSampleUseCase(
    new MikroOrmReconciliationReader(persistence.orm.em),
    new ReconcileWalletUseCase(
      new MikroOrmReconciliationReader(persistence.orm.em),
      logger,
      metrics,
    ),
    clock,
    { sampleSize, recentWindowMs: 60_000 },
  );

test('every sampled wallet is checked and only the corrupted one is reported, untouched', async () => {
  const healthy = await newWallet('100.00');
  const corrupted = await newWallet('100.00');
  await applyOperation(persistence.unitOfWork, healthy, WagerTransactionKind.Bet, '10.00');
  await applyOperation(persistence.unitOfWork, corrupted, WagerTransactionKind.Bet, '10.00');
  await bypass((tx) => tx`UPDATE wallets SET balance_amount = 95.00 WHERE id = ${corrupted}`);
  checks.length = 0;
  errors.length = 0;
  try {
    const report = await sampler(new ManualClock(), 100).runOnce('reconciliation:test');

    expect(report.checked).toBe(2);
    expect(report.divergentWalletIds).toEqual([corrupted]);
    expect(checks).toHaveLength(2);
    expect(checks.every((check) => check.trigger === 'sampled')).toBe(true);
    expect(checks.filter((check) => !check.consistent)).toHaveLength(1);
    expect(errors).toEqual([
      expect.objectContaining({ walletId: corrupted, trigger: 'sampled', balancesMatch: false }),
    ]);
    const [row] =
      await admin`SELECT balance_amount::text AS b FROM wallets WHERE id = ${corrupted}`;
    expect(row.b).toBe('95.00'); // reported, never "fixed"
  } finally {
    await bypass((tx) => tx`UPDATE wallets SET balance_amount = 90.00 WHERE id = ${corrupted}`);
  }
});

test('wallets changed within the window are sampled before idle ones', async () => {
  const idle = await newWallet('50.00');
  const active = await newWallet('50.00');
  // Every wallet but `active` looks untouched for a day.
  await bypass(
    (tx) => tx`UPDATE wallets SET created_at = now() - interval '1 day',
                                  updated_at = now() - interval '1 day'
                WHERE id <> ${active}`,
  );
  const reader = new MikroOrmReconciliationReader(persistence.orm.em);
  const recentSince = new Date(Date.now() - 60_000);
  for (let draw = 0; draw < 5; draw++) {
    expect(await reader.sampleWalletIds(1, recentSince)).toEqual([active]);
  }
  // With nothing recent, the sample is drawn at random: idle wallets get covered too.
  const all = await reader.sampleWalletIds(100, new Date(Date.now() + 60_000));
  expect(all).toHaveLength(4);
  expect(all).toContain(idle);
  expect((await sampler(new ManualClock(), 1).runOnce('reconciliation:test')).checked).toBe(1);
});
