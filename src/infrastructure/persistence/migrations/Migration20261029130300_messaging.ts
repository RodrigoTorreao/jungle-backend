import { Migration } from '@mikro-orm/migrations';

/**
 * inbox_messages — persistent dedup of consumed messages, keyed by (consumer_name, message_id).
 * outbox_messages — integration events committed with the change that produced them.
 *
 * Outbox rows may only move forward: once published they are frozen, and the event itself
 * (type, version, payload) never changes.
 */
export class Migration20261029130300_messaging extends Migration {
  override name = 'Migration20261029130300_messaging';

  override up(): void {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text        NOT NULL,
        message_id    text        NOT NULL,
        payload_hash  char(64)    NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id),
        CONSTRAINT ck_inbox_identifiers CHECK (
          length(consumer_name) BETWEEN 1 AND 128 AND length(message_id) BETWEEN 1 AND 256
        ),
        CONSTRAINT ck_inbox_payload_hash CHECK (payload_hash ~ '^[0-9a-f]{64}$')
      );
    `);
    this.addSql(`
      CREATE TRIGGER trg_inbox_no_delete
        BEFORE DELETE ON inbox_messages
        FOR EACH ROW EXECUTE FUNCTION forbid_row_mutation();
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid        PRIMARY KEY,
        aggregate_id    text        NOT NULL,
        event_type      text        NOT NULL,
        event_version   integer     NOT NULL,
        correlation_id  text        NOT NULL,
        payload         jsonb       NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer     NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at    timestamptz,
        last_error      text,
        CONSTRAINT ck_outbox_event_version CHECK (event_version >= 1),
        CONSTRAINT ck_outbox_attempts CHECK (attempts >= 0),
        CONSTRAINT ck_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
        CONSTRAINT ck_outbox_schedule CHECK (
          (published_at IS NULL) = (next_attempt_at IS NOT NULL)
        )
      );
    `);
    this.addSql(`
      CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL;
    `);
    this.addSql(`
      CREATE FUNCTION outbox_guard_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.published_at IS NOT NULL THEN
          RAISE EXCEPTION 'outbox message % is already published', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.event_version, NEW.correlation_id,
            NEW.payload, NEW.occurred_at)
           IS DISTINCT FROM
           (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.event_version, OLD.correlation_id,
            OLD.payload, OLD.occurred_at) THEN
          RAISE EXCEPTION 'outbox message % event data is immutable', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.attempts < OLD.attempts THEN
          RAISE EXCEPTION 'outbox message % attempts cannot go backwards', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_outbox_guard_update
        BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION outbox_guard_update();
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE outbox_messages;');
    this.addSql('DROP FUNCTION outbox_guard_update();');
    this.addSql('DROP TABLE inbox_messages;');
  }
}
