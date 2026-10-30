/**
 * Out-of-order references (Desafio.md §7.1, T-C07): parked transactions, the "nudge" when the
 * reference arrives, exponential backoff, attempt limit and TTL — with a hand-driven clock.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { TRUSTED } from '../../../src/application/ports/identity';
import {
  type ProcessWagerCommand,
  ProcessWagerTransactionUseCase,
} from '../../../src/application/use-cases/process-wager-transaction';
import { ReprocessPendingReferencesUseCase } from '../../../src/application/use-cases/reprocess-pending-references';
import { DEFAULT_REFERENCE_RETRY_POLICY } from '../../../src/domain/wagering/wager-transaction';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wagering/wager-transaction-kind';
import { MikroOrmWagerTransactionReader } from '../../../src/infrastructure/persistence/repositories';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { connectPersistence, ids, type Persistence } from '../../support/persistence';
import { ManualClock } from '../../support/sqs';

let db: TestDatabase;
let persistence: Persistence;
let owner: SQL;

beforeAll(async () => {
  db = await createTestDatabase();
  persistence = await connectPersistence(db);
  owner = new SQL(db.ownerUrl, { max: 1 });
});

afterAll(async () => {
  await assertLedgerConsistency(db.ownerUrl);
  await owner.close();
  await persistence.close();
  await db.drop();
});

function setup(policy = DEFAULT_REFERENCE_RETRY_POLICY) {
  const clock = new ManualClock(new Date(Date.now() + 60_000));
  const process = new ProcessWagerTransactionUseCase(persistence.unitOfWork, ids, clock);
  const worker = new ReprocessPendingReferencesUseCase(
    persistence.unitOfWork,
    new MikroOrmWagerTransactionReader(persistence.orm.em),
    ids,
    clock,
    policy,
  );
  return { clock, process, worker };
}

async function newWallet(amount = '100.00') {
  const view = await persistence.createWallet.execute({
    playerId: ids.next(),
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'test',
    principal: TRUSTED,
  });
  return { id: view.id, playerId: view.playerId };
}

function command(
  wallet: { id: string; playerId: string },
  kind: Kind,
  amount: string,
  extra: { externalTransactionId?: string; reference?: string; roundId?: string } = {},
): ProcessWagerCommand {
  const externalTransactionId = extra.externalTransactionId ?? `tx-${ids.next()}`;
  return {
    submission: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: extra.roundId ?? 'round-1',
      gameId: 'game-1',
      kind,
      money: { amount, currency: 'BRL' },
      referenceExternalTransactionId: extra.reference,
    },
    idempotencyKey: `provider-a:${externalTransactionId}`,
    principal: { kind: 'trusted' },
    correlationId: 'corr-pending',
    causationId: externalTransactionId,
    source: 'http',
  };
}

const balance = async (walletId: string) =>
  (await persistence.reader.findWallet(walletId))?.balance.toJSON().amount;
async function transaction(id: string) {
  const [row] = await owner`SELECT status, failure_code, reference_attempts, next_attempt_at
                              FROM wager_transactions WHERE id = ${id}`;
  return row as {
    status: string;
    failure_code: string | null;
    reference_attempts: number;
    next_attempt_at: Date | null;
  };
}
const eventsOf = async (transactionId: string) =>
  (
    await owner`SELECT event_type FROM outbox_messages
                 WHERE aggregate_id = ${transactionId}
                    OR payload->'data'->>'transactionId' = ${transactionId}
                 ORDER BY occurred_at, event_type`
  ).map((row: { event_type: string }) => row.event_type);

describe('T-C07 — a REFUND that arrives before its BET', () => {
  test('is parked, woken up by the BET and then applied by the worker', async () => {
    const { clock, process, worker } = setup();
    const wallet = await newWallet('100.00');
    const betId = `bet-${ids.next()}`;

    const refund = await process.execute(
      command(wallet, Kind.Refund, '30.00', { reference: betId }),
    );
    expect(refund.status).toBe(Status.PendingReference);
    expect((await transaction(refund.transactionId)).next_attempt_at?.getTime()).toBe(
      clock.now().getTime() + 1_000,
    );

    await process.execute(command(wallet, Kind.Bet, '30.00', { externalTransactionId: betId }));
    expect(await balance(wallet.id)).toBe('70.00');
    // Nudge: due right now, without waiting for the backoff.
    expect((await transaction(refund.transactionId)).next_attempt_at?.getTime()).toBe(
      clock.now().getTime(),
    );

    expect(await worker.runOnce(10)).toEqual({
      processed: 1,
      rejected: 0,
      rescheduled: 0,
      skipped: 0,
    });
    expect(await transaction(refund.transactionId)).toMatchObject({
      status: 'PROCESSED',
      next_attempt_at: null,
    });
    expect(await balance(wallet.id)).toBe('100.00');
    expect(await eventsOf(refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('a chain resolves in order: ROLLBACK of a parked REFUND waits for it', async () => {
    const { process, worker } = setup();
    const wallet = await newWallet('100.00');
    const betId = `bet-${ids.next()}`;
    const refundId = `refund-${ids.next()}`;

    await process.execute(
      command(wallet, Kind.Refund, '10.00', { externalTransactionId: refundId, reference: betId }),
    );
    const rollback = await process.execute(
      command(wallet, Kind.Rollback, '10.00', { reference: refundId }),
    );
    expect(rollback.status).toBe(Status.PendingReference);

    await process.execute(command(wallet, Kind.Bet, '10.00', { externalTransactionId: betId }));
    await worker.runOnce(10); // REFUND applied, ROLLBACK woken up
    await worker.runOnce(10); // ROLLBACK applied
    expect((await transaction(rollback.transactionId)).status).toBe('PROCESSED');
    expect(await balance(wallet.id)).toBe('90.00'); // bet −10, refund +10, rollback of refund −10
  });

  test('a reference that arrives but belongs to another round is rejected by the worker', async () => {
    const { process, worker } = setup();
    const wallet = await newWallet('100.00');
    const betId = `bet-${ids.next()}`;
    const refund = await process.execute(
      command(wallet, Kind.Refund, '5.00', { reference: betId }),
    );
    await process.execute(
      command(wallet, Kind.Bet, '5.00', { externalTransactionId: betId, roundId: 'round-other' }),
    );

    expect((await worker.runOnce(10)).rejected).toBe(1);
    expect(await transaction(refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_MISMATCH',
    });
    expect(await balance(wallet.id)).toBe('95.00');
  });
});

describe('a reference that never arrives', () => {
  test('backs off exponentially and is rejected with REFERENCE_NOT_FOUND after the TTL', async () => {
    const { clock, process, worker } = setup();
    const wallet = await newWallet('100.00');
    const refund = await process.execute(
      command(wallet, Kind.Refund, '5.00', { reference: `ghost-${ids.next()}` }),
    );

    expect((await worker.runOnce(10)).rescheduled).toBe(0); // not due yet
    clock.advance(1_000);
    expect((await worker.runOnce(10)).rescheduled).toBe(1);
    expect(await transaction(refund.transactionId)).toMatchObject({ reference_attempts: 1 });
    expect((await transaction(refund.transactionId)).next_attempt_at?.getTime()).toBe(
      clock.now().getTime() + 2_000,
    );

    clock.advance(DEFAULT_REFERENCE_RETRY_POLICY.ttlMs);
    expect((await worker.runOnce(10)).rejected).toBe(1);
    expect(await transaction(refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      next_attempt_at: null,
    });
    expect((await eventsOf(refund.transactionId)).at(-1)).toBe('WagerTransactionRejected');
    expect(await balance(wallet.id)).toBe('100.00');
  });

  test('is rejected once the attempt limit is reached, before the TTL', async () => {
    const { clock, process, worker } = setup({
      ...DEFAULT_REFERENCE_RETRY_POLICY,
      maxAttempts: 2,
    });
    const wallet = await newWallet('100.00');
    const refund = await process.execute(
      command(wallet, Kind.Refund, '5.00', { reference: `ghost-${ids.next()}` }),
    );
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      clock.advance(10_000);
      const report = await worker.runOnce(10);
      outcomes.push(report.rejected ? 'rejected' : report.rescheduled ? 'rescheduled' : 'idle');
    }
    expect(outcomes).toEqual(['rescheduled', 'rescheduled', 'rejected']);
    expect((await transaction(refund.transactionId)).failure_code).toBe('REFERENCE_NOT_FOUND');
  });
});

describe('several workers at once', () => {
  test('each parked transaction is resolved exactly once', async () => {
    const { clock, process } = setup();
    const workers = Array.from(
      { length: 3 },
      () =>
        new ReprocessPendingReferencesUseCase(
          persistence.unitOfWork,
          new MikroOrmWagerTransactionReader(persistence.orm.em),
          ids,
          clock,
        ),
    );
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet('100.00')));
    for (const wallet of wallets) {
      const betId = `bet-${ids.next()}`;
      await process.execute(command(wallet, Kind.Refund, '10.00', { reference: betId }));
      await process.execute(command(wallet, Kind.Bet, '10.00', { externalTransactionId: betId }));
    }

    const reports = await Promise.all(workers.map((worker) => worker.runOnce(50)));
    expect(reports.reduce((sum, report) => sum + report.processed, 0)).toBe(10);
    for (const wallet of wallets) {
      expect(await balance(wallet.id)).toBe('100.00');
    }
    await assertLedgerConsistency(
      db.ownerUrl,
      wallets.map((wallet) => wallet.id),
    );
  });
});
