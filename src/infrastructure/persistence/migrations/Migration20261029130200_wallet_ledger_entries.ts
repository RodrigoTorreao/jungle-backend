import { Migration } from '@mikro-orm/migrations';

/**
 * wallet_ledger_entries — the append-only, auditable ledger.
 *
 * Schema-level guarantees:
 *  - at most one entry per (transaction, wallet); gapless per-wallet sequence (wallet_version)
 *  - entry arithmetic: balance_after = balance_before ± amount, never negative
 *  - the entry belongs to the wallet of its transaction, in the wallet's currency (composite FKs)
 *  - chained: balance_before equals the previous entry's balance_after (trigger)
 *  - immutable: UPDATE/DELETE/TRUNCATE refused by trigger, and not granted to the runtime role
 *  - balance == ledger: at COMMIT, every touched wallet's balance and version must equal its
 *    latest entry (deferred constraint triggers on both tables) — ARCHITECTURE ADR-007
 *  - only PROCESSED transactions of the same amount produce entries, and every PROCESSED
 *    transaction that moves money has its entry (both checked at COMMIT)
 */
export class Migration20261029130200_wallet_ledger_entries extends Migration {
  override name = 'Migration20261029130200_wallet_ledger_entries';

  override up(): void {
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id             uuid          PRIMARY KEY,
        wallet_id      uuid          NOT NULL,
        transaction_id uuid          NOT NULL,
        wallet_version integer       NOT NULL,
        direction      text          NOT NULL,
        amount         numeric(20,2) NOT NULL,
        currency       char(3)       NOT NULL,
        balance_before numeric(20,2) NOT NULL,
        balance_after  numeric(20,2) NOT NULL,
        created_at     timestamptz   NOT NULL,

        CONSTRAINT fk_ledger_wallet_currency FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency),
        CONSTRAINT fk_ledger_transaction_wallet FOREIGN KEY (transaction_id, wallet_id)
          REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT uq_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),
        CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ck_ledger_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT ck_ledger_version_positive CHECK (wallet_version >= 1),
        CONSTRAINT ck_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ck_ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );
    `);

    this.addSql('REVOKE UPDATE, DELETE, TRUNCATE ON wallet_ledger_entries FROM wallet_app;');
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_row_mutation();
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_row_mutation();
    `);

    // Chaining: each entry continues exactly where the previous one of the same wallet ended.
    this.addSql(`
      CREATE FUNCTION ledger_assert_chain() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        previous record;
      BEGIN
        SELECT balance_after, wallet_version INTO previous
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY wallet_version DESC
         LIMIT 1;

        IF NOT FOUND THEN
          -- first entry: OPENING (version 1) or first movement of a wallet opened at zero (2)
          IF NEW.balance_before <> 0 OR NEW.wallet_version NOT IN (1, 2) THEN
            RAISE EXCEPTION 'first ledger entry of wallet % must start at 0 with version 1 or 2',
              NEW.wallet_id USING ERRCODE = 'check_violation';
          END IF;
        ELSIF NEW.balance_before <> previous.balance_after
           OR NEW.wallet_version <> previous.wallet_version + 1 THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: expected before=% version=%, got before=% version=%',
            NEW.wallet_id, previous.balance_after, previous.wallet_version + 1,
            NEW.balance_before, NEW.wallet_version
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_assert_chain
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_assert_chain();
    `);

    // balance == ledger, checked at COMMIT for every wallet touched in the transaction.
    this.addSql(`
      CREATE FUNCTION assert_wallet_matches_ledger() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        target_wallet uuid;
        wallet_row record;
        latest record;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN
          target_wallet := NEW.id;
        ELSE
          target_wallet := NEW.wallet_id;
        END IF;

        -- re-read: several changes in one transaction each queue a check; only the final state counts
        SELECT balance_amount, version INTO wallet_row FROM wallets WHERE id = target_wallet;
        SELECT balance_after, wallet_version INTO latest
          FROM wallet_ledger_entries
         WHERE wallet_id = target_wallet
         ORDER BY wallet_version DESC
         LIMIT 1;

        IF NOT FOUND THEN
          IF wallet_row.balance_amount <> 0 OR wallet_row.version <> 1 THEN
            RAISE EXCEPTION 'wallet % has balance % / version % but no ledger entries',
              target_wallet, wallet_row.balance_amount, wallet_row.version
              USING ERRCODE = 'check_violation';
          END IF;
        ELSIF latest.balance_after <> wallet_row.balance_amount
           OR latest.wallet_version <> wallet_row.version THEN
          RAISE EXCEPTION 'wallet % diverges from its ledger: balance %/% version %/%',
            target_wallet, wallet_row.balance_amount, latest.balance_after,
            wallet_row.version, latest.wallet_version
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wallets_match_ledger
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_wallet_matches_ledger();
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_ledger_matches_wallet
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_wallet_matches_ledger();
    `);

    // A rejected/pending transaction never moves money: entries need a PROCESSED transaction
    // of the same amount. Deferred, because the worker updates a PENDING_REFERENCE row to
    // PROCESSED in the same transaction that books the entry.
    this.addSql(`
      CREATE FUNCTION ledger_assert_transaction_processed() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        tx record;
      BEGIN
        SELECT status, amount, kind INTO tx FROM wager_transactions WHERE id = NEW.transaction_id;
        IF tx.status <> 'PROCESSED' OR tx.amount <> NEW.amount OR tx.kind = 'LOSS' THEN
          RAISE EXCEPTION 'ledger entry % references transaction % (%/% %) that cannot move money',
            NEW.id, NEW.transaction_id, tx.kind, tx.status, tx.amount
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_ledger_transaction_processed
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ledger_assert_transaction_processed();
    `);

    // ...and the other way round: a PROCESSED transaction that moves money has its entry.
    this.addSql(`
      CREATE FUNCTION wager_transaction_assert_ledger() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        entry record;
      BEGIN
        IF NEW.status = 'PROCESSED' AND NEW.kind <> 'LOSS' THEN
          SELECT amount INTO entry
            FROM wallet_ledger_entries
           WHERE transaction_id = NEW.id AND wallet_id = NEW.wallet_id;
          IF NOT FOUND OR entry.amount <> NEW.amount THEN
            RAISE EXCEPTION 'processed % transaction % has no matching ledger entry', NEW.kind, NEW.id
              USING ERRCODE = 'check_violation';
          END IF;
        END IF;
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_tx_processed_has_ledger
        AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wager_transaction_assert_ledger();
    `);
  }

  override down(): void {
    this.addSql('DROP TRIGGER trg_tx_processed_has_ledger ON wager_transactions;');
    this.addSql('DROP FUNCTION wager_transaction_assert_ledger();');
    this.addSql('DROP TRIGGER trg_wallets_match_ledger ON wallets;');
    this.addSql('DROP TABLE wallet_ledger_entries;');
    this.addSql('DROP FUNCTION ledger_assert_transaction_processed();');
    this.addSql('DROP FUNCTION assert_wallet_matches_ledger();');
    this.addSql('DROP FUNCTION ledger_assert_chain();');
  }
}
