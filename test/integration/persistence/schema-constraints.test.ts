/**
 * Restriction 9 of the challenge: uniqueness, immutability and non-negativity are enforced by
 * the schema, not only by application code. Every test builds a valid state with plain SQL and
 * then tries to break exactly one guarantee — directly, bypassing the application.
 *
 * SQLSTATE cheat sheet: 23505 unique, 23503 FK, 23514 check (incl. our triggers),
 * 23001 restrict_violation (immutability triggers), 42501 insufficient privilege.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { SqlWalletBook, txRow, uuid } from '../../support/sql-book';

let db: TestDatabase;
let owner: SQL;
let app: SQL;

beforeAll(async () => {
  db = await createTestDatabase();
  owner = new SQL(db.ownerUrl, { max: 2 });
  app = new SQL(db.appUrl, { max: 2 });
});

afterAll(async () => {
  await assertLedgerConsistency(db.ownerUrl);
  await app.close();
  await owner.close();
  await db.drop();
});

async function expectRejected(
  work: Promise<unknown>,
  expected: { errno: string; constraint?: string },
): Promise<void> {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, 'the database accepted a write it must refuse').toBeDefined();
  expect(error).toMatchObject(expected);
}

const now = () => new Date();

describe('wallets', () => {
  test('balance can never be negative', async () => {
    const book = await SqlWalletBook.open(owner, '0.00');
    await expectRejected(
      owner`UPDATE wallets SET balance_amount = -0.01 WHERE id = ${book.walletId}`,
      { errno: '23514', constraint: 'ck_wallets_balance_non_negative' },
    );
  });

  test('one wallet per player and currency', async () => {
    const book = await SqlWalletBook.open(owner, '0.00');
    await expectRejected(
      owner`INSERT INTO wallets ${owner({
        id: uuid(),
        player_id: book.playerId,
        currency: 'BRL',
        balance_amount: '0.00',
        version: 1,
        created_at: now(),
        updated_at: now(),
      })}`,
      { errno: '23505', constraint: 'uq_wallets_player_currency' },
    );
  });

  test('the same player may hold wallets in different currencies', async () => {
    const book = await SqlWalletBook.open(owner, '0.00');
    await owner`INSERT INTO wallets ${owner({
      id: uuid(),
      player_id: book.playerId,
      currency: 'USD',
      balance_amount: '0.00',
      version: 1,
      created_at: now(),
      updated_at: now(),
    })}`;
  });

  test('currency must be an ISO-4217 code', async () => {
    await expectRejected(
      owner`INSERT INTO wallets ${owner({
        id: uuid(),
        player_id: uuid(),
        currency: 'brl',
        balance_amount: '0.00',
        version: 1,
        created_at: now(),
        updated_at: now(),
      })}`,
      { errno: '23514', constraint: 'ck_wallets_currency_format' },
    );
  });

  test('a balance without ledger entries is refused at COMMIT', async () => {
    await expectRejected(
      owner`INSERT INTO wallets ${owner({
        id: uuid(),
        player_id: uuid(),
        currency: 'BRL',
        balance_amount: '50.00',
        version: 1,
        created_at: now(),
        updated_at: now(),
      })}`,
      { errno: '23514' },
    );
  });

  test('changing the balance without booking an entry is refused at COMMIT', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    await expectRejected(
      owner`UPDATE wallets SET balance_amount = 90.00, version = 2 WHERE id = ${book.walletId}`,
      { errno: '23514' },
    );
    await expectRejected(owner`UPDATE wallets SET version = 2 WHERE id = ${book.walletId}`, {
      errno: '23514',
    });
  });
});

describe('wallet_ledger_entries', () => {
  test('a legitimate movement commits (transaction + entry + wallet update)', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    await book.book(owner, { kind: 'BET', amount: '80.00', direction: 'DEBIT' });
    await book.book(owner, { kind: 'WIN', amount: '5.50', direction: 'CREDIT' });
    expect(book.currentBalance).toBe('25.50');
    await assertLedgerConsistency(db.ownerUrl, [book.walletId]);
  });

  test('the runtime role cannot UPDATE, DELETE or TRUNCATE the ledger', async () => {
    const book = await SqlWalletBook.open(owner, '10.00');
    await expectRejected(
      app`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ${book.walletId}`,
      { errno: '42501' },
    );
    await expectRejected(
      app`DELETE FROM wallet_ledger_entries WHERE wallet_id = ${book.walletId}`,
      { errno: '42501' },
    );
    await expectRejected(app`TRUNCATE wallet_ledger_entries`, { errno: '42501' });
  });

  test('not even the schema owner can rewrite or erase history', async () => {
    const book = await SqlWalletBook.open(owner, '10.00');
    await expectRejected(
      owner`UPDATE wallet_ledger_entries SET created_at = now() WHERE wallet_id = ${book.walletId}`,
      { errno: '23001' },
    );
    await expectRejected(
      owner`DELETE FROM wallet_ledger_entries WHERE wallet_id = ${book.walletId}`,
      { errno: '23001' },
    );
    await expectRejected(owner`TRUNCATE wallet_ledger_entries CASCADE`, { errno: '23001' });
  });

  async function tryEntry(book: SqlWalletBook, entry: Record<string, unknown>) {
    const tx = txRow(book.walletId, book.playerId, { amount: entry.amount ?? '10.00' });
    return owner.begin(async (t) => {
      await t`INSERT INTO wager_transactions ${t(tx)}`;
      await t`INSERT INTO wallet_ledger_entries ${t({
        id: uuid(),
        wallet_id: book.walletId,
        transaction_id: tx.id,
        wallet_version: book.currentVersion + 1,
        direction: 'DEBIT',
        amount: '10.00',
        currency: 'BRL',
        balance_before: book.currentBalance,
        balance_after: '90.00',
        created_at: now(),
        ...entry,
      })}`;
    });
  }

  test('entry arithmetic must balance', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    await expectRejected(tryEntry(book, { balance_after: '91.00' }), {
      errno: '23514',
      constraint: 'ck_ledger_arithmetic',
    });
  });

  test('an entry cannot leave a negative balance', async () => {
    const book = await SqlWalletBook.open(owner, '5.00');
    await expectRejected(tryEntry(book, { balance_after: '-5.00' }), { errno: '23514' });
  });

  test('the chain cannot skip or rewrite the previous balance', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    await expectRejected(tryEntry(book, { balance_before: '200.00', balance_after: '190.00' }), {
      errno: '23514',
    });
    await expectRejected(tryEntry(book, { wallet_version: book.currentVersion + 2 }), {
      errno: '23514',
    });
  });

  test('an entry must be in the wallet currency', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    await expectRejected(tryEntry(book, { currency: 'USD' }), {
      errno: '23503',
      constraint: 'fk_ledger_wallet_currency',
    });
  });

  test("an entry cannot be booked on another wallet's transaction", async () => {
    const a = await SqlWalletBook.open(owner, '100.00');
    const b = await SqlWalletBook.open(owner, '100.00');
    const booked = await a.book(owner, { kind: 'BET', amount: '10.00', direction: 'DEBIT' });
    await expectRejected(
      owner`INSERT INTO wallet_ledger_entries ${owner({
        id: uuid(),
        wallet_id: b.walletId,
        transaction_id: booked.txId,
        wallet_version: 2,
        direction: 'DEBIT',
        amount: '10.00',
        currency: 'BRL',
        balance_before: '100.00',
        balance_after: '90.00',
        created_at: now(),
      })}`,
      { errno: '23503', constraint: 'fk_ledger_transaction_wallet' },
    );
  });

  test('a transaction produces at most one entry per wallet (no double debit)', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    const booked = await book.book(owner, { kind: 'BET', amount: '10.00', direction: 'DEBIT' });
    await expectRejected(
      owner`INSERT INTO wallet_ledger_entries ${owner({
        id: uuid(),
        wallet_id: book.walletId,
        transaction_id: booked.txId,
        wallet_version: book.currentVersion + 1,
        direction: 'DEBIT',
        amount: '10.00',
        currency: 'BRL',
        balance_before: book.currentBalance,
        balance_after: '80.00',
        created_at: now(),
      })}`,
      { errno: '23505', constraint: 'uq_ledger_transaction_wallet' },
    );
  });

  test('a rejected transaction can never move money (refused at COMMIT)', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    const rejected = txRow(book.walletId, book.playerId, {
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
      result_balance_amount: '100.00',
    });
    await expectRejected(
      owner.begin(async (t) => {
        await t`INSERT INTO wager_transactions ${t(rejected)}`;
        await t`INSERT INTO wallet_ledger_entries ${t({
          id: uuid(),
          wallet_id: book.walletId,
          transaction_id: rejected.id,
          wallet_version: 2,
          direction: 'DEBIT',
          amount: '10.00',
          currency: 'BRL',
          balance_before: '100.00',
          balance_after: '90.00',
          created_at: now(),
        })}`;
        await t`UPDATE wallets SET balance_amount = 90.00, version = 2 WHERE id = ${book.walletId}`;
      }),
      { errno: '23514' },
    );
  });
});

describe('wager_transactions', () => {
  test('idempotency key and external id are unique per provider', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    const booked = await book.book(owner, { kind: 'BET', amount: '1.00', direction: 'DEBIT' });
    const duplicateKey = txRow(book.walletId, book.playerId, {
      idempotency_key: `provider-a:${booked.externalId}`,
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
    await expectRejected(owner`INSERT INTO wager_transactions ${owner(duplicateKey)}`, {
      errno: '23505',
      constraint: 'uq_tx_idempotency',
    });
    const duplicateExternal = txRow(book.walletId, book.playerId, {
      external_transaction_id: booked.externalId,
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
    await expectRejected(owner`INSERT INTO wager_transactions ${owner(duplicateExternal)}`, {
      errno: '23505',
      constraint: 'uq_tx_external_id',
    });
  });

  test('a processed BET without its ledger entry is refused at COMMIT', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    await expectRejected(
      owner`INSERT INTO wager_transactions ${owner(txRow(book.walletId, book.playerId))}`,
      { errno: '23514' },
    );
  });

  test('REFUND and ROLLBACK need a reference; BET cannot have one', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    for (const kind of ['REFUND', 'ROLLBACK']) {
      await expectRejected(
        owner`INSERT INTO wager_transactions ${owner(
          txRow(book.walletId, book.playerId, {
            kind,
            status: 'REJECTED',
            failure_code: 'REFERENCE_NOT_FOUND',
          }),
        )}`,
        { errno: '23514', constraint: 'ck_tx_reference_required' },
      );
    }
    await expectRejected(
      owner`INSERT INTO wager_transactions ${owner(
        txRow(book.walletId, book.playerId, {
          reference_external_transaction_id: 'something',
          status: 'REJECTED',
          failure_code: 'INSUFFICIENT_FUNDS',
        }),
      )}`,
      { errno: '23514', constraint: 'ck_tx_reference_not_allowed' },
    );
  });

  test('a reference is reversed at most once, whatever the reversal kind (I-01)', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    const bet = await book.book(owner, { kind: 'BET', amount: '10.00', direction: 'DEBIT' });
    const reversal = (kind: string) => ({
      kind,
      amount: '10.00',
      direction: 'CREDIT' as const,
      overrides: {
        reference_external_transaction_id: bet.externalId,
        reference_transaction_id: bet.txId,
      },
    });
    await book.book(owner, reversal('REFUND'));
    await expectRejected(book.book(owner, reversal('REFUND')), {
      errno: '23505',
      constraint: 'uq_tx_single_reversal',
    });
    await expectRejected(book.book(owner, reversal('ROLLBACK')), {
      errno: '23505',
      constraint: 'uq_tx_single_reversal',
    });
  });

  test('only the internal provider creates OPENING, once per wallet', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    await expectRejected(
      owner`INSERT INTO wager_transactions ${owner(
        txRow(book.walletId, book.playerId, { kind: 'OPENING', amount: '1.00' }),
      )}`,
      { errno: '23514', constraint: 'ck_tx_opening_is_internal' },
    );
    await expectRejected(
      owner`INSERT INTO wager_transactions ${owner(
        txRow(book.walletId, book.playerId, {
          kind: 'OPENING',
          provider_id: 'internal',
          status: 'FAILED',
          failure_code: 'INVARIANT_VIOLATION',
        }),
      )}`,
      { errno: '23505', constraint: 'uq_tx_opening_per_wallet' },
    );
  });

  test('status and columns stay coherent', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    const insert = (overrides: Record<string, unknown>) =>
      owner`INSERT INTO wager_transactions ${owner(txRow(book.walletId, book.playerId, overrides))}`;

    await expectRejected(insert({ status: 'REJECTED' }), {
      errno: '23514',
      constraint: 'ck_tx_failure_code',
    });
    await expectRejected(
      insert({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', processed_at: null }),
      { errno: '23514', constraint: 'ck_tx_processed_at' },
    );
    await expectRejected(
      insert({
        kind: 'REFUND',
        reference_external_transaction_id: 'bet-x',
        status: 'PENDING_REFERENCE',
        processed_at: null,
      }),
      { errno: '23514', constraint: 'ck_tx_retry_schedule' },
    );
    await expectRejected(insert({ amount: '0.00' }), {
      errno: '23514',
      constraint: 'ck_tx_amount',
    });
  });

  test('terminal transactions are frozen', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    const bet = await book.book(owner, { kind: 'BET', amount: '10.00', direction: 'DEBIT' });
    await expectRejected(
      owner`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS'
             WHERE id = ${bet.txId}`,
      { errno: '23001' },
    );
    await expectRejected(
      owner`UPDATE wager_transactions SET updated_at = now() WHERE id = ${bet.txId}`,
      { errno: '23001' },
    );
  });

  test('business columns of a pending transaction never change', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    const pending = txRow(book.walletId, book.playerId, {
      kind: 'REFUND',
      amount: '10.00',
      reference_external_transaction_id: 'bet-not-yet',
      status: 'PENDING_REFERENCE',
      processed_at: null,
      next_attempt_at: now(),
      result_balance_amount: '100.00',
    });
    await owner`INSERT INTO wager_transactions ${owner(pending)}`;

    await owner`UPDATE wager_transactions SET reference_attempts = 1, next_attempt_at = now()
                 WHERE id = ${pending.id}`;
    await expectRejected(
      owner`UPDATE wager_transactions SET amount = 99.00 WHERE id = ${pending.id}`,
      { errno: '23001' },
    );
  });

  test('transactions are never deleted', async () => {
    const book = await SqlWalletBook.open(owner, '100.00');
    await expectRejected(app`DELETE FROM wager_transactions WHERE wallet_id = ${book.walletId}`, {
      errno: '42501',
    });
    await expectRejected(owner`DELETE FROM wager_transactions WHERE wallet_id = ${book.walletId}`, {
      errno: '23001',
    });
  });
});

describe('inbox and outbox', () => {
  test('a message is received once per consumer', async () => {
    const row = {
      consumer_name: 'wager-transactions',
      message_id: `msg-${uuid()}`,
      payload_hash: 'b'.repeat(64),
      received_at: now(),
      processed_at: now(),
    };
    await app`INSERT INTO inbox_messages ${app(row)}`;
    await expectRejected(app`INSERT INTO inbox_messages ${app(row)}`, {
      errno: '23505',
      constraint: 'pk_inbox_messages',
    });
    await app`INSERT INTO inbox_messages ${app({ ...row, consumer_name: 'another-consumer' })}`;
    await expectRejected(app`DELETE FROM inbox_messages`, { errno: '42501' });
  });

  test('a published outbox message is frozen and event data never changes', async () => {
    const id = uuid();
    await app`INSERT INTO outbox_messages ${app({
      id,
      aggregate_id: 'wallet-1',
      event_type: 'WalletOpened',
      event_version: 1,
      correlation_id: 'corr-1',
      payload: { eventId: id },
      occurred_at: now(),
      attempts: 0,
      next_attempt_at: now(),
    })}`;

    await expectRejected(
      app`UPDATE outbox_messages SET payload = ${{ eventId: 'tampered' }} WHERE id = ${id}`,
      { errno: '23001' },
    );
    await expectRejected(app`UPDATE outbox_messages SET published_at = now() WHERE id = ${id}`, {
      errno: '23514',
      constraint: 'ck_outbox_schedule',
    });
    await app`UPDATE outbox_messages SET published_at = now(), next_attempt_at = NULL WHERE id = ${id}`;
    await expectRejected(
      app`UPDATE outbox_messages SET published_at = NULL, next_attempt_at = now() WHERE id = ${id}`,
      { errno: '23001' },
    );
    await expectRejected(app`DELETE FROM outbox_messages WHERE id = ${id}`, { errno: '42501' });
  });
});
