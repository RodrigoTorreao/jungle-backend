/**
 * Wallet creation races: many concurrent requests for the same (player, currency) must yield
 * exactly one wallet — the unique constraint decides, not application code.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertLedgerConsistency } from '../support/ledger-consistency';
import { type ApiHarness, ids, postJson, startApi } from '../support/persistence';

const PARALLEL_REQUESTS = 30;

let db: TestDatabase;
let api: ApiHarness;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await startApi(db, { DATABASE_POOL_MAX: String(PARALLEL_REQUESTS) });
});

afterAll(async () => {
  await api.close();
  await db.drop();
});

test(`${PARALLEL_REQUESTS} concurrent creations for one player: one 201, the rest 409`, async () => {
  const playerId = ids.next();
  const responses = await Promise.all(
    Array.from({ length: PARALLEL_REQUESTS }, () =>
      postJson(`${api.baseUrl}/wallets`, {
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    ),
  );

  const statuses = responses.map((response) => response.status).sort();
  expect(statuses.filter((status) => status === 201)).toHaveLength(1);
  expect(statuses.filter((status) => status === 409)).toHaveLength(PARALLEL_REQUESTS - 1);

  const owner = new SQL(db.ownerUrl, { max: 1 });
  try {
    const [counts] = await owner`
      SELECT (SELECT count(*)::int FROM wallets WHERE player_id = ${playerId}) AS wallets,
             (SELECT count(*)::int FROM wager_transactions WHERE player_id = ${playerId}) AS openings,
             (SELECT count(*)::int FROM wallet_ledger_entries l
                JOIN wallets w ON w.id = l.wallet_id WHERE w.player_id = ${playerId}) AS entries`;
    expect(counts).toEqual({ wallets: 1, openings: 1, entries: 1 });
  } finally {
    await owner.close();
  }
  await assertLedgerConsistency(db.ownerUrl);
});
