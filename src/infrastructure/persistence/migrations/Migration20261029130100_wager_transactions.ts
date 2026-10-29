import { Migration } from '@mikro-orm/migrations';

/**
 * wager_transactions — every provider operation, its outcome and the snapshot used for replay.
 *
 * Schema-level guarantees:
 *  - idempotency: UNIQUE (provider_id, idempotency_key) and UNIQUE (provider_id, external_transaction_id)
 *  - at most one effective reversal per reference, whatever its kind (I-01)
 *  - at most one OPENING per wallet, and OPENING only from the internal provider
 *  - status/column coherence (failure code, processed_at, retry schedule, resolved reference)
 *  - terminal rows are frozen and business columns never change (trigger)
 *  - rows are never deleted (trigger; the runtime role has no DELETE grant either)
 */
export class Migration20261029130100_wager_transactions extends Migration {
  override name = 'Migration20261029130100_wager_transactions';

  override up(): void {
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid          PRIMARY KEY,
        provider_id                       text          NOT NULL,
        external_transaction_id           text          NOT NULL,
        idempotency_key                   text          NOT NULL,
        payload_hash                      char(64)      NOT NULL,
        wallet_id                         uuid          NOT NULL REFERENCES wallets (id),
        player_id                         uuid          NOT NULL,
        round_id                          text          NOT NULL,
        game_id                           text          NOT NULL,
        kind                              text          NOT NULL,
        amount                            numeric(20,2) NOT NULL,
        currency                          char(3)       NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid          REFERENCES wager_transactions (id),
        status                            text          NOT NULL,
        failure_code                      text,
        result_balance_amount             numeric(20,2),
        result_balance_currency           char(3),
        reference_attempts                integer       NOT NULL DEFAULT 0,
        next_attempt_at                   timestamptz,
        created_at                        timestamptz   NOT NULL,
        processed_at                      timestamptz,
        updated_at                        timestamptz   NOT NULL,

        CONSTRAINT uq_tx_idempotency UNIQUE (provider_id, idempotency_key),
        CONSTRAINT uq_tx_external_id UNIQUE (provider_id, external_transaction_id),
        -- lets the ledger require that an entry belongs to the wallet of its transaction
        CONSTRAINT uq_tx_id_wallet UNIQUE (id, wallet_id),

        CONSTRAINT ck_tx_kind CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT ck_tx_status CHECK (
          status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),
        CONSTRAINT ck_tx_identifiers CHECK (
          length(provider_id) BETWEEN 1 AND 128
          AND length(external_transaction_id) BETWEEN 1 AND 256
          AND length(idempotency_key) BETWEEN 1 AND 256
          AND length(round_id) BETWEEN 1 AND 256
          AND length(game_id) BETWEEN 1 AND 256
        ),
        CONSTRAINT ck_tx_payload_hash CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT ck_tx_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ck_tx_amount CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
        CONSTRAINT ck_tx_result_balance_non_negative CHECK (result_balance_amount >= 0),
        CONSTRAINT ck_tx_result_balance_pair CHECK (
          (result_balance_amount IS NULL) = (result_balance_currency IS NULL)
        ),
        CONSTRAINT ck_tx_reference_attempts CHECK (reference_attempts >= 0),
        CONSTRAINT ck_tx_opening_is_internal CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
        CONSTRAINT ck_tx_reference_required CHECK (
          kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL
        ),
        CONSTRAINT ck_tx_reference_not_allowed CHECK (
          kind NOT IN ('OPENING', 'BET') OR reference_external_transaction_id IS NULL
        ),
        CONSTRAINT ck_tx_no_self_reference CHECK (
          reference_external_transaction_id IS DISTINCT FROM external_transaction_id
          AND reference_transaction_id IS DISTINCT FROM id
        ),
        CONSTRAINT ck_tx_failure_code CHECK (
          (status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)
        ),
        CONSTRAINT ck_tx_processed_at CHECK (
          (status IN ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at IS NOT NULL)
        ),
        CONSTRAINT ck_tx_retry_schedule CHECK (
          (status = 'PENDING_REFERENCE') = (next_attempt_at IS NOT NULL)
        ),
        CONSTRAINT ck_tx_result_balance_recorded CHECK (
          status IN ('PENDING', 'FAILED') OR result_balance_amount IS NOT NULL
        ),
        CONSTRAINT ck_tx_reversal_resolved CHECK (
          status <> 'PROCESSED'
          OR kind NOT IN ('REFUND', 'ROLLBACK')
          OR reference_transaction_id IS NOT NULL
        )
      );
    `);

    // One effective reversal per reference, regardless of REFUND/ROLLBACK (interpretation I-01).
    this.addSql(`
      CREATE UNIQUE INDEX uq_tx_single_reversal ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);
    this.addSql(`
      CREATE UNIQUE INDEX uq_tx_opening_per_wallet ON wager_transactions (wallet_id)
        WHERE kind = 'OPENING';
    `);
    // Pending-reference worker: due rows, and the "nudge" when a reference finally arrives.
    this.addSql(`
      CREATE INDEX ix_tx_pending_due ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX ix_tx_pending_by_reference
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql('CREATE INDEX ix_tx_wallet_created ON wager_transactions (wallet_id, created_at);');

    this.addSql(`
      CREATE FUNCTION wager_transactions_guard_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%) and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key,
            NEW.payload_hash, NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind,
            NEW.amount, NEW.currency, NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key,
            OLD.payload_hash, OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind,
            OLD.amount, OLD.currency, OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'business columns of wager transaction % are immutable', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_wager_transactions_guard_update
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard_update();
    `);
    this.addSql(`
      CREATE TRIGGER trg_wager_transactions_no_delete
        BEFORE DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_row_mutation();
    `);
    this.addSql(`
      CREATE TRIGGER trg_wager_transactions_no_truncate
        BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_row_mutation();
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE wager_transactions;');
    this.addSql('DROP FUNCTION wager_transactions_guard_update();');
  }
}
