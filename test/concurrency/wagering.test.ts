/**
 * Real parallelism, real PostgreSQL (Desafio §8 and §13, T-C01..T-C03). Requests are fired
 * together with Promise.all over HTTP, and through the use case from independent connection
 * pools — the same contention two application instances would create.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction-kind';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertLedgerConsistency } from '../support/ledger-consistency';
import {
  type ApiHarness,
  clock,
  connectPersistence,
  getJson,
  ids,
  type Persistence,
  startApi,
} from '../support/persistence';
import { createWallet, submission, submit, type WalletRef } from '../support/wagering';

let db: TestDatabase;
let api: ApiHarness;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await startApi(db, { DATABASE_POOL_MAX: '20' });
});

afterAll(async () => {
  await assertLedgerConsistency(db.ownerUrl);
  await api.close();
  await db.drop();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const walletView = async (wallet: WalletRef) =>
  (await getJson(`${api.baseUrl}/wallets/${wallet.id}`)).body;

async function debitEntries(walletId: string): Promise<number> {
  const sql = new SQL(db.ownerUrl, { max: 1 });
  try {
    const [row] = await sql`SELECT count(*)::int AS n FROM wallet_ledger_entries
                             WHERE wallet_id = ${walletId} AND direction = 'DEBIT'`;
    return row.n;
  } finally {
    await sql.close();
  }
}

const count = <T>(items: T[], predicate: (item: T) => boolean) => items.filter(predicate).length;

describe('T-C01 — the same bet sent 50 times in parallel', () => {
  test('debits once; every response is the same transaction', async () => {
    const wallet = await createWallet(api.baseUrl, '1000.00');
    const bet = submission(wallet, 'BET', '25.00');

    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(api.baseUrl, bet)));

    expect(count(responses, (r) => r.status === 200)).toBe(50);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(count(responses, (r) => r.body.idempotentReplay === false)).toBe(1);
    expect(new Set(responses.map((r) => r.body.balance.amount))).toEqual(new Set(['975.00']));
    expect(await walletView(wallet)).toMatchObject({ balance: brl('975.00'), version: 2 });
    expect(await debitEntries(wallet.id)).toBe(1);
    await assertLedgerConsistency(db.ownerUrl, [wallet.id]);
  });
});

describe('T-C02 — 100.00 and two simultaneous bets of 80.00', () => {
  test('over HTTP, 50 wallets at once: exactly one PROCESSED and one REJECTED each', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 50 }, () => createWallet(api.baseUrl, '100.00')),
    );

    const outcomes = await Promise.all(
      wallets.map(async (wallet) => {
        const responses = await Promise.all([
          submit(api.baseUrl, submission(wallet, 'BET', '80.00')),
          submit(api.baseUrl, submission(wallet, 'BET', '80.00')),
        ]);
        return { wallet, responses };
      }),
    );

    for (const { wallet, responses } of outcomes) {
      expect(responses.map((r) => r.status).sort()).toEqual([200, 422]);
      expect(responses.find((r) => r.status === 422)?.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
      });
      expect((await walletView(wallet)).balance).toEqual(brl('20.00'));
      expect(await debitEntries(wallet.id)).toBe(1);
    }
    await assertLedgerConsistency(
      db.ownerUrl,
      wallets.map((wallet) => wallet.id),
    );
  });

  describe('through the use case from two independent connection pools', () => {
    let instanceA: Persistence;
    let instanceB: Persistence;

    beforeAll(async () => {
      [instanceA, instanceB] = await Promise.all([
        connectPersistence(db, { poolMax: 15 }),
        connectPersistence(db, { poolMax: 15 }),
      ]);
    });

    afterAll(async () => {
      await Promise.all([instanceA.close(), instanceB.close()]);
    });

    test('25 wallets, one bet from each "instance": one wins, the other is rejected', async () => {
      const useCaseA = new ProcessWagerTransactionUseCase(instanceA.unitOfWork, ids, clock);
      const useCaseB = new ProcessWagerTransactionUseCase(instanceB.unitOfWork, ids, clock);
      const wallets = await Promise.all(
        Array.from({ length: 25 }, () => createWallet(api.baseUrl, '100.00')),
      );

      const bet = (wallet: WalletRef, useCase: ProcessWagerTransactionUseCase) => {
        const externalTransactionId = `tx-${ids.next()}`;
        return useCase.execute({
          submission: {
            providerId: 'provider-a',
            externalTransactionId,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'round-1',
            gameId: 'game-1',
            kind: WagerTransactionKind.Bet,
            money: brl('80.00'),
          },
          idempotencyKey: `provider-a:${externalTransactionId}`,
          principal: { kind: 'trusted' },
          correlationId: 'tc02-pools',
          causationId: externalTransactionId,
        });
      };

      const results = await Promise.all(
        wallets.map((wallet) => Promise.all([bet(wallet, useCaseA), bet(wallet, useCaseB)])),
      );
      for (const pair of results) {
        expect(pair.map((result) => result.status).sort()).toEqual([
          WagerTransactionStatus.Processed,
          WagerTransactionStatus.Rejected,
        ]);
      }
      for (const wallet of wallets) {
        expect((await walletView(wallet)).balance).toEqual(brl('20.00'));
      }
      await assertLedgerConsistency(
        db.ownerUrl,
        wallets.map((wallet) => wallet.id),
      );
    });
  });
});

describe('hot wallet — more bets than the balance can cover', () => {
  test('40 concurrent bets of 5.00 on 100.00: exactly 20 processed, never negative', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const responses = await Promise.all(
      Array.from({ length: 40 }, () => submit(api.baseUrl, submission(wallet, 'BET', '5.00'))),
    );

    expect(count(responses, (r) => r.status === 200)).toBe(20);
    expect(count(responses, (r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(20);
    expect(await walletView(wallet)).toMatchObject({ balance: brl('0.00'), version: 21 });
    await assertLedgerConsistency(db.ownerUrl, [wallet.id]);
  });
});

describe('T-C03 — distinct wallets in parallel', () => {
  test('20 wallets × 10 bets fired together all succeed independently', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 20 }, () => createWallet(api.baseUrl, '50.00')),
    );
    const responses = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 10 }, () => submit(api.baseUrl, submission(wallet, 'BET', '1.00'))),
      ),
    );

    expect(count(responses, (r) => r.status === 200)).toBe(200);
    for (const wallet of wallets) {
      expect(await walletView(wallet)).toMatchObject({ balance: brl('40.00'), version: 11 });
    }
    await assertLedgerConsistency(
      db.ownerUrl,
      wallets.map((wallet) => wallet.id),
    );
  });
});

describe('idempotency key race across different wallets', () => {
  test('the same key aimed at two wallets at once: one processed, one 409 conflict', async () => {
    const pairs = await Promise.all(
      Array.from({ length: 20 }, async () => [
        await createWallet(api.baseUrl, '100.00'),
        await createWallet(api.baseUrl, '100.00'),
      ]),
    );

    const outcomes = await Promise.all(
      pairs.map(async ([first, second]) => {
        if (!first || !second) throw new Error('wallet pair missing');
        const externalTransactionId = `shared-${ids.next()}`;
        const responses = await Promise.all([
          submit(api.baseUrl, submission(first, 'BET', '10.00', { externalTransactionId })),
          submit(api.baseUrl, submission(second, 'BET', '10.00', { externalTransactionId })),
        ]);
        return { first, second, responses };
      }),
    );

    for (const { first, second, responses } of outcomes) {
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(responses.find((r) => r.status === 409)?.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      const balances = [(await walletView(first)).balance, (await walletView(second)).balance];
      expect(balances.map((b) => b.amount).sort()).toEqual(['100.00', '90.00']);
    }
  });
});
