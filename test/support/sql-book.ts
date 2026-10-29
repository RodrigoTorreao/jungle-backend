/**
 * Writes valid wallet movements with plain SQL, bypassing the application, so schema tests can
 * build a legitimate starting state and then try to break exactly one guarantee.
 */
import type { SQL } from 'bun';
import { Money } from '../../src/domain/money/money';

export const uuid = (): string => Bun.randomUUIDv7();
export const HASH = 'a'.repeat(64);

export type Direction = 'DEBIT' | 'CREDIT';

export interface TxRowOverrides {
  readonly [column: string]: unknown;
}

/** A complete, valid wager_transactions row (PROCESSED BET by default). */
export function txRow(
  walletId: string,
  playerId: string,
  overrides: TxRowOverrides = {},
): Record<string, unknown> {
  const externalId = `ext-${uuid()}`;
  const now = new Date();
  return {
    id: uuid(),
    provider_id: 'provider-a',
    external_transaction_id: externalId,
    idempotency_key: `provider-a:${externalId}`,
    payload_hash: HASH,
    wallet_id: walletId,
    player_id: playerId,
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: 'PROCESSED',
    failure_code: null,
    result_balance_amount: '0.00',
    result_balance_currency: 'BRL',
    reference_attempts: 0,
    next_attempt_at: null,
    created_at: now,
    processed_at: now,
    updated_at: now,
    ...overrides,
  };
}

export interface Booked {
  readonly txId: string;
  readonly externalId: string;
}

export class SqlWalletBook {
  private constructor(
    readonly walletId: string,
    readonly playerId: string,
    readonly currency: string,
    private balance: Money,
    private version: number,
  ) {}

  get currentBalance(): string {
    return this.balance.toJSON().amount;
  }

  get currentVersion(): number {
    return this.version;
  }

  /** Opens a wallet; a positive balance gets its OPENING transaction and ledger entry. */
  static async open(sql: SQL, balance = '100.00', currency = 'BRL'): Promise<SqlWalletBook> {
    const book = new SqlWalletBook(
      uuid(),
      uuid(),
      currency,
      Money.from({ amount: balance, currency }),
      1,
    );
    const now = new Date();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO wallets ${tx({
        id: book.walletId,
        player_id: book.playerId,
        currency,
        balance_amount: balance,
        version: 1,
        created_at: now,
        updated_at: now,
      })}`;
      if (book.balance.isPositive()) {
        const opening = txRow(book.walletId, book.playerId, {
          provider_id: 'internal',
          external_transaction_id: `opening:${book.walletId}`,
          idempotency_key: `opening:${book.walletId}`,
          kind: 'OPENING',
          amount: balance,
          currency,
          result_balance_amount: balance,
          result_balance_currency: currency,
        });
        await tx`INSERT INTO wager_transactions ${tx(opening)}`;
        await tx`INSERT INTO wallet_ledger_entries ${tx({
          id: uuid(),
          wallet_id: book.walletId,
          transaction_id: opening.id,
          wallet_version: 1,
          direction: 'CREDIT',
          amount: balance,
          currency,
          balance_before: '0.00',
          balance_after: balance,
          created_at: now,
        })}`;
      }
    });
    return book;
  }

  /**
   * Books a PROCESSED transaction, its ledger entry and the wallet update in one SQL
   * transaction — the shape every legitimate money movement must have.
   */
  async book(
    sql: SQL,
    input: { kind: string; amount: string; direction: Direction; overrides?: TxRowOverrides },
  ): Promise<Booked> {
    const money = Money.from({ amount: input.amount, currency: this.currency });
    const after =
      input.direction === 'CREDIT' ? this.balance.add(money) : this.balance.subtract(money);
    const row = txRow(this.walletId, this.playerId, {
      kind: input.kind,
      amount: input.amount,
      currency: this.currency,
      result_balance_amount: after.toJSON().amount,
      result_balance_currency: this.currency,
      ...input.overrides,
    });
    const now = new Date();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO wager_transactions ${tx(row)}`;
      await tx`INSERT INTO wallet_ledger_entries ${tx({
        id: uuid(),
        wallet_id: this.walletId,
        transaction_id: row.id,
        wallet_version: this.version + 1,
        direction: input.direction,
        amount: input.amount,
        currency: this.currency,
        balance_before: this.balance.toJSON().amount,
        balance_after: after.toJSON().amount,
        created_at: now,
      })}`;
      await tx`UPDATE wallets
                  SET balance_amount = ${after.toJSON().amount}, version = ${this.version + 1},
                      updated_at = ${now}
                WHERE id = ${this.walletId}`;
    });
    this.balance = after;
    this.version += 1;
    return { txId: row.id as string, externalId: row.external_transaction_id as string };
  }
}
