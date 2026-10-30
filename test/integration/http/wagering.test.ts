/**
 * POST /wagering/transactions end to end against the real database (S3-08): every business
 * rule of Desafio.md §7, idempotency (§9) and the outbox events of each outcome (§11).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { type ApiHarness, getJson, ids, postJson, startApi } from '../../support/persistence';
import { testEnv, withDatabase } from '../../support/test-env';
import {
  countRows,
  createWallet,
  outboxFor,
  PROVIDER,
  submission,
  submit,
  type WalletRef,
} from '../../support/wagering';

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

const balanceOf = async (wallet: WalletRef) =>
  (await getJson(`${api.baseUrl}/wallets/${wallet.id}`)).body;

const brl = (amount: string) => ({ amount, currency: 'BRL' });

describe('BET', () => {
  test('debits the wallet: 200 PROCESSED with the resulting balance', async () => {
    const wallet = await createWallet(api.baseUrl, '1000.00');
    const response = await submit(api.baseUrl, submission(wallet, 'BET', '25.00'));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'PROCESSED',
      balance: brl('975.00'),
      idempotentReplay: false,
    });
    expect(await balanceOf(wallet)).toMatchObject({ balance: brl('975.00'), version: 2 });
  });

  test('without funds: 422 REJECTED INSUFFICIENT_FUNDS, nothing moves', async () => {
    const wallet = await createWallet(api.baseUrl, '10.00');
    const response = await submit(api.baseUrl, submission(wallet, 'BET', '10.01'));

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('10.00'),
      idempotentReplay: false,
    });
    expect(await balanceOf(wallet)).toMatchObject({ balance: brl('10.00'), version: 1 });
    expect(
      await countRows(
        db.ownerUrl,
        'SELECT count(*)::int FROM wallet_ledger_entries WHERE transaction_id = $1',
        response.body.transactionId,
      ),
    ).toBe(0);
  });
});

describe('WIN and LOSS', () => {
  test('WIN referencing the BET credits and links the reference', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const bet = submission(wallet, 'BET', '10.00');
    const betResponse = await submit(api.baseUrl, bet);
    const win = await submit(
      api.baseUrl,
      submission(wallet, 'WIN', '35.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    expect(win.status).toBe(200);
    expect(win.body.balance).toEqual(brl('125.00'));
    const view = await getJson(`${api.baseUrl}/wagering/transactions/${win.body.transactionId}`);
    expect(view.body.referenceTransactionId).toBe(betResponse.body.transactionId);
  });

  test('LOSS records the result without moving balance or version', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const bet = submission(wallet, 'BET', '10.00');
    await submit(api.baseUrl, bet);
    const loss = await submit(
      api.baseUrl,
      submission(wallet, 'LOSS', '0.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    expect(loss.status).toBe(200);
    expect(loss.body).toMatchObject({ status: 'PROCESSED', balance: brl('90.00') });
    expect(await balanceOf(wallet)).toMatchObject({ balance: brl('90.00'), version: 2 });
  });
});

describe('REFUND and ROLLBACK', () => {
  async function walletWithBet(balance: string, amount: string) {
    const wallet = await createWallet(api.baseUrl, balance);
    const bet = submission(wallet, 'BET', amount);
    await submit(api.baseUrl, bet);
    return { wallet, bet };
  }
  const reversal = (wallet: WalletRef, kind: string, amount: string, ref: string, extra = {}) =>
    submission(wallet, kind, amount, { referenceExternalTransactionId: ref, ...extra });

  test('REFUND credits a processed BET back', async () => {
    const { wallet, bet } = await walletWithBet('100.00', '30.00');
    const response = await submit(
      api.baseUrl,
      reversal(wallet, 'REFUND', '30.00', bet.externalTransactionId),
    );
    expect(response.status).toBe(200);
    expect(response.body.balance).toEqual(brl('100.00'));
  });

  test('a BET is reversed only once, whatever the reversal kind (I-01)', async () => {
    const { wallet, bet } = await walletWithBet('100.00', '30.00');
    await submit(api.baseUrl, reversal(wallet, 'REFUND', '30.00', bet.externalTransactionId));

    for (const kind of ['REFUND', 'ROLLBACK']) {
      const again = await submit(
        api.baseUrl,
        reversal(wallet, kind, '30.00', bet.externalTransactionId),
      );
      expect(again.status).toBe(422);
      expect(again.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    }
    expect((await balanceOf(wallet)).balance).toEqual(brl('100.00'));
  });

  test.each([
    ['a different amount', '29.99', {}, 'REVERSAL_AMOUNT_MISMATCH'],
    ['another round', '30.00', { roundId: 'round-other' }, 'REFERENCE_MISMATCH'],
  ])('REFUND with %s is rejected', async (_case, amount, extra, code) => {
    const { wallet, bet } = await walletWithBet('100.00', '30.00');
    const response = await submit(
      api.baseUrl,
      reversal(wallet, 'REFUND', amount, bet.externalTransactionId, extra),
    );
    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe(code);
    expect((await balanceOf(wallet)).balance).toEqual(brl('70.00'));
  });

  test('REFUND only reverses a BET', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const win = submission(wallet, 'WIN', '5.00');
    await submit(api.baseUrl, win);
    const response = await submit(
      api.baseUrl,
      reversal(wallet, 'REFUND', '5.00', win.externalTransactionId),
    );
    expect(response.body.failureCode).toBe('REFERENCE_KIND_NOT_REVERSIBLE');
  });

  test('ROLLBACK of a BET credits; ROLLBACK of a WIN debits', async () => {
    const { wallet, bet } = await walletWithBet('100.00', '40.00');
    const rollbackBet = await submit(
      api.baseUrl,
      reversal(wallet, 'ROLLBACK', '40.00', bet.externalTransactionId),
    );
    expect(rollbackBet.body.balance).toEqual(brl('100.00'));

    const win = submission(wallet, 'WIN', '15.00');
    await submit(api.baseUrl, win);
    const rollbackWin = await submit(
      api.baseUrl,
      reversal(wallet, 'ROLLBACK', '15.00', win.externalTransactionId),
    );
    expect(rollbackWin.status).toBe(200);
    expect(rollbackWin.body.balance).toEqual(brl('100.00'));
  });

  test('a ROLLBACK that would overdraw is rejected with its own code', async () => {
    const wallet = await createWallet(api.baseUrl, '0.00');
    const win = submission(wallet, 'WIN', '50.00');
    await submit(api.baseUrl, win);
    await submit(api.baseUrl, submission(wallet, 'BET', '45.00'));

    const response = await submit(
      api.baseUrl,
      reversal(wallet, 'ROLLBACK', '50.00', win.externalTransactionId),
    );
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      failureCode: 'REVERSAL_WOULD_OVERDRAW',
      balance: brl('5.00'),
    });
  });

  test('a reversal arriving before its reference is accepted as PENDING_REFERENCE (202)', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const betId = `late-bet-${ids.next()}`;
    const refund = reversal(wallet, 'REFUND', '20.00', betId);

    const early = await submit(api.baseUrl, refund);
    expect(early.status).toBe(202);
    expect(early.body).toMatchObject({
      status: 'PENDING_REFERENCE',
      balance: brl('100.00'),
      idempotentReplay: false,
    });

    const replay = await submit(api.baseUrl, refund);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ ...early.body, idempotentReplay: true });

    const bet = await submit(
      api.baseUrl,
      submission(wallet, 'BET', '20.00', { externalTransactionId: betId }),
    );
    expect(bet.status).toBe(200);
    // Resolution of the parked REFUND is the pending-reference worker's job (Sprint 4).
    const view = await getJson(`${api.baseUrl}/wagering/transactions/${early.body.transactionId}`);
    expect(view.body.status).toBe('PENDING_REFERENCE');
  });
});

describe('wallet-level rejections', () => {
  test('a player that does not own the wallet: 422 WALLET_PLAYER_MISMATCH', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const response = await submit(
      api.baseUrl,
      submission(wallet, 'BET', '1.00', { playerId: ids.next() }),
    );
    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
  });

  test('another currency: 422 CURRENCY_MISMATCH, balance reported in the wallet currency', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const response = await submit(
      api.baseUrl,
      submission(wallet, 'BET', '1.00', { money: { amount: '1.00', currency: 'USD' } }),
    );
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      failureCode: 'CURRENCY_MISMATCH',
      balance: brl('100.00'),
    });
  });

  test('an unknown wallet: 422 WALLET_NOT_FOUND and nothing persisted (I-04)', async () => {
    const body = submission({ id: ids.next(), playerId: ids.next() }, 'BET', '1.00');
    const response = await submit(api.baseUrl, body);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: 'WALLET_NOT_FOUND', retryable: false });
    expect(
      await countRows(
        db.ownerUrl,
        'SELECT count(*)::int FROM wager_transactions WHERE external_transaction_id = $1',
        body.externalTransactionId,
      ),
    ).toBe(0);
  });
});

describe('contract validation (400)', () => {
  test('Idempotency-Key is mandatory', async () => {
    const wallet = await createWallet(api.baseUrl, '10.00');
    const response = await submit(api.baseUrl, submission(wallet, 'BET', '1.00'), {
      idempotencyKey: null,
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  test.each([
    ['OPENING (internal only)', { kind: 'OPENING' }, 'UNSUPPORTED_KIND'],
    ['an unknown kind', { kind: 'JACKPOT' }, 'VALIDATION_ERROR'],
    ['REFUND without reference', { kind: 'REFUND' }, 'MISSING_REFERENCE'],
    ['BET with a reference', { referenceExternalTransactionId: 'x' }, 'VALIDATION_ERROR'],
    ['a float amount', { money: { amount: 1, currency: 'BRL' } }, 'VALIDATION_ERROR'],
    ['three decimals', { money: { amount: '1.005', currency: 'BRL' } }, 'INVALID_MONEY'],
    ['the reserved provider id', { providerId: 'internal' }, 'VALIDATION_ERROR'],
    ['a zero BET', { money: { amount: '0.00', currency: 'BRL' } }, 'INVALID_MONEY'],
  ])('rejects %s', async (_case, overrides, code) => {
    const wallet = await createWallet(api.baseUrl, '10.00');
    const response = await submit(api.baseUrl, submission(wallet, 'BET', '1.00', overrides));
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(code);
  });
});

describe('idempotency', () => {
  test('an identical retry returns the original response, balance included', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const bet = submission(wallet, 'BET', '10.00');
    const first = await submit(api.baseUrl, bet);
    await submit(api.baseUrl, submission(wallet, 'BET', '50.00'));

    const replay = await submit(api.baseUrl, bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual(brl('90.00')); // not today's 40.00
    expect((await balanceOf(wallet)).balance).toEqual(brl('40.00'));
  });

  test('a replayed rejection is still a 422 with the original balance', async () => {
    const wallet = await createWallet(api.baseUrl, '5.00');
    const bet = submission(wallet, 'BET', '10.00');
    const first = await submit(api.baseUrl, bet);
    const replay = await submit(api.baseUrl, bet);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('same key with a different payload is a 409 conflict, not a replay', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const bet = submission(wallet, 'BET', '10.00');
    await submit(api.baseUrl, bet);
    const tampered = await submit(api.baseUrl, { ...bet, money: brl('99.00') });

    expect(tampered.status).toBe(409);
    expect(tampered.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', retryable: false });
    expect((await balanceOf(wallet)).balance).toEqual(brl('90.00'));
  });

  test('the same external id under another key is a 409 conflict', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const bet = submission(wallet, 'BET', '10.00');
    await submit(api.baseUrl, bet);
    const response = await submit(api.baseUrl, bet, { idempotencyKey: `other-key-${ids.next()}` });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EXTERNAL_TRANSACTION_ID_CONFLICT');
  });

  test('transport metadata (correlation id) does not change the payload hash', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const bet = submission(wallet, 'BET', '10.00');
    await submit(api.baseUrl, bet, { correlationId: 'first' });
    const replay = await submit(api.baseUrl, bet, { correlationId: 'second' });
    expect(replay.body.idempotentReplay).toBe(true);
  });
});

describe('outbox events per outcome', () => {
  test('processed BET → WagerTransactionProcessed + WalletBalanceChanged, with tracing ids', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const bet = submission(wallet, 'BET', '10.00');
    const response = await submit(api.baseUrl, bet, { correlationId: 'corr-outbox-1' });

    const events = await outboxFor(db.ownerUrl, [response.body.transactionId]);
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const event of events) {
      expect(event.correlation_id).toBe('corr-outbox-1');
      expect(event.payload.causationId).toBe(`${PROVIDER}:${bet.externalTransactionId}`);
    }
    expect(events[1]?.payload.data).toMatchObject({
      direction: 'DEBIT',
      balanceAfter: brl('90.00'),
      walletVersion: 2,
    });
  });

  test('LOSS → only WagerTransactionProcessed (balance unchanged)', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const response = await submit(api.baseUrl, submission(wallet, 'LOSS', '0.00'));
    const events = await outboxFor(db.ownerUrl, [response.body.transactionId]);
    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionProcessed']);
  });

  test('rejection → WagerTransactionRejected; pending → WagerTransactionPendingReference', async () => {
    const wallet = await createWallet(api.baseUrl, '1.00');
    const rejected = await submit(api.baseUrl, submission(wallet, 'BET', '5.00'));
    const pending = await submit(
      api.baseUrl,
      submission(wallet, 'REFUND', '5.00', {
        referenceExternalTransactionId: `nope-${ids.next()}`,
      }),
    );
    expect(
      (await outboxFor(db.ownerUrl, [rejected.body.transactionId])).map((e) => e.event_type),
    ).toEqual(['WagerTransactionRejected']);
    expect(
      (await outboxFor(db.ownerUrl, [pending.body.transactionId])).map((e) => e.event_type),
    ).toEqual(['WagerTransactionPendingReference']);
  });

  test('a replay enqueues nothing new', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const bet = submission(wallet, 'BET', '10.00');
    const response = await submit(api.baseUrl, bet);
    await submit(api.baseUrl, bet);
    await submit(api.baseUrl, bet);
    expect(await outboxFor(db.ownerUrl, [response.body.transactionId])).toHaveLength(2);
  });
});

describe('transaction queries', () => {
  test('by internal id and by provider + external id', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    const bet = submission(wallet, 'BET', '10.00');
    const response = await submit(api.baseUrl, bet);

    const byId = await getJson(
      `${api.baseUrl}/wagering/transactions/${response.body.transactionId}`,
    );
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: response.body.transactionId,
      providerId: PROVIDER,
      externalTransactionId: bet.externalTransactionId,
      walletId: wallet.id,
      kind: 'BET',
      money: brl('10.00'),
      status: 'PROCESSED',
      failureCode: null,
      balance: brl('90.00'),
    });

    const byExternal = await getJson(
      `${api.baseUrl}/providers/${PROVIDER}/wagering/transactions/${bet.externalTransactionId}`,
    );
    expect(byExternal.body).toEqual(byId.body);
  });

  test('404 for unknown transactions, 400 for a malformed id', async () => {
    expect((await getJson(`${api.baseUrl}/wagering/transactions/${ids.next()}`)).status).toBe(404);
    expect((await getJson(`${api.baseUrl}/wagering/transactions/abc`)).status).toBe(400);
    expect(
      (await getJson(`${api.baseUrl}/providers/${PROVIDER}/wagering/transactions/missing`)).status,
    ).toBe(404);
  });
});

describe('POST /wallets/:id/reconciliation', () => {
  const reconcile = (walletId: string) =>
    postJson(`${api.baseUrl}/wallets/${walletId}/reconciliation`, {});

  test('a wallet that went through every kind of movement is consistent', async () => {
    const wallet = await createWallet(api.baseUrl, '1000.00');
    const bet = submission(wallet, 'BET', '25.00');
    await submit(api.baseUrl, bet);
    await submit(api.baseUrl, submission(wallet, 'WIN', '60.00'));
    await submit(api.baseUrl, submission(wallet, 'BET', '5000.00')); // rejected
    await submit(
      api.baseUrl,
      submission(wallet, 'REFUND', '25.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    const response = await reconcile(wallet.id);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: brl('1060.00'),
      calculatedBalance: brl('1060.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 4,
    });
  });

  test('a divergence that bypassed every guarantee is reported, never corrected', async () => {
    const wallet = await createWallet(api.baseUrl, '100.00');
    await submit(api.baseUrl, submission(wallet, 'BET', '10.00'));
    // Simulates a manual fix gone wrong: a superuser disables triggers for its session.
    const admin = new SQL(withDatabase(testEnv.adminUrl, db.name), { max: 1 });
    const corrupt = (amount: string) =>
      admin.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`UPDATE wallets SET balance_amount = ${amount} WHERE id = ${wallet.id}`;
      });
    try {
      await corrupt('95.00');
      const response = await reconcile(wallet.id);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        storedBalance: brl('95.00'),
        calculatedBalance: brl('90.00'),
        difference: brl('5.00'),
        consistent: false,
        checkedEntries: 2,
      });
      expect((await balanceOf(wallet)).balance).toEqual(brl('95.00')); // not "fixed"
    } finally {
      await corrupt('90.00');
      await admin.close();
    }
  });

  test('404 for an unknown wallet', async () => {
    expect((await reconcile(ids.next())).status).toBe(404);
  });
});
