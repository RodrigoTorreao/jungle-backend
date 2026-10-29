import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction-kind';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import {
  type ApiHarness,
  applyOperation,
  connectPersistence,
  getJson,
  ids,
  type Persistence,
  postJson,
  startApi,
} from '../../support/persistence';

let db: TestDatabase;
let api: ApiHarness;
let persistence: Persistence;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await startApi(db);
  persistence = await connectPersistence(db);
});

afterAll(async () => {
  await assertLedgerConsistency(db.ownerUrl);
  await persistence.close();
  await api.close();
  await db.drop();
});

const createWallet = (body: unknown, headers?: Record<string, string>) =>
  postJson(`${api.baseUrl}/wallets`, body, headers);

const validBody = (amount = '1000.00') => ({
  playerId: ids.next(),
  initialBalance: { amount, currency: 'BRL' },
});

describe('POST /wallets', () => {
  test('creates a wallet with an OPENING credit (201, version 1)', async () => {
    const body = validBody('1000.00');
    const response = await createWallet(body);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      playerId: body.playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });

    const ledger = await getJson(`${api.baseUrl}/wallets/${response.body.id}/ledger`);
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]).toMatchObject({
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
    });
  });

  test('a zero initial balance creates no ledger entry', async () => {
    const response = await createWallet(validBody('0.00'));
    expect(response.status).toBe(201);
    const ledger = await getJson(`${api.baseUrl}/wallets/${response.body.id}/ledger`);
    expect(ledger.body).toEqual({ items: [], nextCursor: null });
  });

  test('a second wallet for the same player and currency is a 409 conflict', async () => {
    const body = validBody('10.00');
    expect((await createWallet(body)).status).toBe(201);
    const duplicate = await createWallet({
      ...body,
      initialBalance: { amount: '99.00', currency: 'BRL' },
    });

    expect(duplicate.status).toBe(409);
    expect(duplicate.headers.get('content-type')).toContain('application/problem+json');
    expect(duplicate.body).toMatchObject({
      status: 409,
      code: 'WALLET_ALREADY_EXISTS',
      retryable: false,
    });
  });

  test('the same player may open a wallet in another currency', async () => {
    const body = validBody('10.00');
    await createWallet(body);
    const usd = await createWallet({
      ...body,
      initialBalance: { amount: '5.00', currency: 'USD' },
    });
    expect(usd.status).toBe(201);
    expect(usd.body.balance).toEqual({ amount: '5.00', currency: 'USD' });
  });

  test.each([
    ['a number amount', { initialBalance: { amount: 10, currency: 'BRL' } }, 'VALIDATION_ERROR'],
    [
      'a negative amount',
      { initialBalance: { amount: '-1.00', currency: 'BRL' } },
      'INVALID_MONEY',
    ],
    ['three decimals', { initialBalance: { amount: '1.005', currency: 'BRL' } }, 'INVALID_MONEY'],
    [
      'scientific notation',
      { initialBalance: { amount: '1e3', currency: 'BRL' } },
      'INVALID_MONEY',
    ],
    [
      'a lowercase currency',
      { initialBalance: { amount: '1.00', currency: 'brl' } },
      'INVALID_MONEY',
    ],
    ['a non-uuid player', { playerId: 'player-1' }, 'VALIDATION_ERROR'],
    ['an unknown field', { bonus: '10.00' }, 'VALIDATION_ERROR'],
  ])('rejects %s with 400', async (_case, overrides, code) => {
    const response = await createWallet({ ...validBody(), ...overrides });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ status: 400, code, retryable: false });
  });

  test('rejects a malformed JSON body with 400', async () => {
    const response = await createWallet('{"playerId":');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  test('problem details carry the correlation id', async () => {
    const response = await createWallet({}, { 'x-correlation-id': 'corr-problem-1' });
    expect(response.body.correlationId).toBe('corr-problem-1');
    expect(response.body.instance).toBe('/wallets');
  });
});

describe('GET /wallets/:walletId', () => {
  test('returns the current balance and version', async () => {
    const created = await createWallet(validBody('100.00'));
    await applyOperation(persistence.unitOfWork, created.body.id, Kind.Bet, '25.00');

    const response = await getJson(`${api.baseUrl}/wallets/${created.body.id}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: created.body.id,
      playerId: created.body.playerId,
      balance: { amount: '75.00', currency: 'BRL' },
      version: 2,
    });
  });

  test('404 for an unknown wallet, 400 for a malformed id', async () => {
    expect((await getJson(`${api.baseUrl}/wallets/${ids.next()}`)).body).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect((await getJson(`${api.baseUrl}/wallets/not-a-uuid`)).status).toBe(400);
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  test('pages newest first with a stable, opaque cursor', async () => {
    const created = await createWallet(validBody('100.00'));
    const walletId: string = created.body.id;
    for (let i = 0; i < 6; i++) {
      await applyOperation(persistence.unitOfWork, walletId, Kind.Bet, '1.00');
    }
    // versions 1 (opening) .. 7

    const first = await getJson(`${api.baseUrl}/wallets/${walletId}/ledger?limit=3`);
    expect(first.status).toBe(200);
    expect(first.body.items.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([
      7, 6, 5,
    ]);
    expect(typeof first.body.nextCursor).toBe('string');

    // entries appended after the first page do not shift the following pages
    await applyOperation(persistence.unitOfWork, walletId, Kind.Win, '2.00');

    const second = await getJson(
      `${api.baseUrl}/wallets/${walletId}/ledger?limit=3&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([
      4, 3, 2,
    ]);

    const last = await getJson(
      `${api.baseUrl}/wallets/${walletId}/ledger?limit=3&cursor=${second.body.nextCursor}`,
    );
    expect(last.body.items.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([1]);
    expect(last.body.nextCursor).toBeNull();
  });

  test('defaults to 50 items and rejects out-of-range limits', async () => {
    const created = await createWallet(validBody('10.00'));
    const url = `${api.baseUrl}/wallets/${created.body.id}/ledger`;
    expect((await getJson(url)).status).toBe(200);
    expect((await getJson(`${url}?limit=0`)).status).toBe(400);
    expect((await getJson(`${url}?limit=201`)).status).toBe(400);
    expect((await getJson(`${url}?limit=abc`)).status).toBe(400);
  });

  test('rejects a tampered cursor or a cursor from another wallet', async () => {
    const a = await createWallet(validBody('10.00'));
    const b = await createWallet(validBody('10.00'));
    for (let i = 0; i < 2; i++) {
      await applyOperation(persistence.unitOfWork, a.body.id, Kind.Bet, '1.00');
    }
    const page = await getJson(`${api.baseUrl}/wallets/${a.body.id}/ledger?limit=1`);
    const foreign = await getJson(
      `${api.baseUrl}/wallets/${b.body.id}/ledger?cursor=${page.body.nextCursor}`,
    );
    expect(foreign.status).toBe(400);
    expect(
      (await getJson(`${api.baseUrl}/wallets/${a.body.id}/ledger?cursor=garbage`)).status,
    ).toBe(400);
  });

  test('404 for an unknown wallet', async () => {
    expect((await getJson(`${api.baseUrl}/wallets/${ids.next()}/ledger`)).status).toBe(404);
  });
});
