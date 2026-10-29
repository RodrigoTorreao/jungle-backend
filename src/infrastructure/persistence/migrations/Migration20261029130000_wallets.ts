import { Migration } from '@mikro-orm/migrations';

/**
 * wallets — the materialized balance.
 * Guarantees in the schema: one wallet per (player, currency), balance never negative,
 * version >= 1. `UNIQUE (id, currency)` lets the ledger reference (wallet, currency) so an
 * entry can never be booked in another currency than its wallet.
 */
export class Migration20261029130000_wallets extends Migration {
  override name = 'Migration20261029130000_wallets';

  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id             uuid          PRIMARY KEY,
        player_id      uuid          NOT NULL,
        currency       char(3)       NOT NULL,
        balance_amount numeric(20,2) NOT NULL,
        version        integer       NOT NULL,
        created_at     timestamptz   NOT NULL,
        updated_at     timestamptz   NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT uq_wallets_id_currency UNIQUE (id, currency),
        CONSTRAINT ck_wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ck_wallets_balance_non_negative CHECK (balance_amount >= 0),
        CONSTRAINT ck_wallets_version_positive CHECK (version >= 1),
        CONSTRAINT ck_wallets_timestamps CHECK (updated_at >= created_at)
      );
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE wallets;');
  }
}
