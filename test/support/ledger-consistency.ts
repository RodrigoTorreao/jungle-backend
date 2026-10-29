import { expect } from 'bun:test';
import { SQL } from 'bun';

interface WalletLedgerCheck {
  wallet_id: string;
  stored_balance: string;
  stored_version: number;
  calculated_balance: string;
  last_balance_after: string | null;
  last_version: number | null;
  entries: number;
  max_version: number | null;
  min_version: number | null;
}

/**
 * The invariant every integration/concurrency test ends with (Desafio §13):
 *   wallet.balance == balance rebuilt from the ledger (Σ CREDIT − Σ DEBIT)
 * plus: the latest entry matches balance and version, and the per-wallet sequence is gapless.
 * All arithmetic happens in PostgreSQL `numeric`; values are compared as decimal strings.
 */
export async function assertLedgerConsistency(databaseUrl: string, walletIds?: string[]) {
  const sql = new SQL(databaseUrl, { max: 1 });
  try {
    const rows: WalletLedgerCheck[] = await sql`
      SELECT w.id AS wallet_id,
             w.balance_amount::text AS stored_balance,
             w.version AS stored_version,
             COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
               ::numeric(20,2)::text AS calculated_balance,
             (SELECT balance_after::text FROM wallet_ledger_entries
               WHERE wallet_id = w.id ORDER BY wallet_version DESC LIMIT 1) AS last_balance_after,
             MAX(l.wallet_version) AS last_version,
             COUNT(l.id)::int AS entries,
             MAX(l.wallet_version) AS max_version,
             MIN(l.wallet_version) AS min_version
        FROM wallets w
        LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
       WHERE ${walletIds === undefined ? sql`TRUE` : sql`w.id IN ${sql(walletIds)}`}
       GROUP BY w.id`;

    if (walletIds !== undefined) {
      expect(rows.length).toBe(walletIds.length);
    }
    for (const row of rows) {
      const context = `wallet ${row.wallet_id}`;
      expect(row.calculated_balance, `${context}: balance rebuilt from ledger`).toBe(
        row.stored_balance,
      );
      if (row.entries === 0) {
        expect(row.stored_version, `${context}: version without entries`).toBe(1);
        continue;
      }
      expect(row.last_balance_after, `${context}: latest entry balance`).toBe(row.stored_balance);
      expect(row.last_version, `${context}: latest entry version`).toBe(row.stored_version);
      const expectedEntries = (row.max_version ?? 0) - (row.min_version ?? 0) + 1;
      expect(row.entries, `${context}: gapless ledger sequence`).toBe(expectedEntries);
    }
    return rows.length;
  } finally {
    await sql.close();
  }
}
