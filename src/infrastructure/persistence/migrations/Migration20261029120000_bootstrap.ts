import { Migration } from '@mikro-orm/migrations';

/**
 * Schema-level privileges and shared helpers.
 *
 * - The runtime role (`wallet_app`) gets USAGE on the schema and, by default, only
 *   SELECT/INSERT/UPDATE on tables created by the owner. No DELETE, no TRUNCATE, no DDL.
 *   Append-only tables (ledger) revoke UPDATE explicitly in their own migration.
 * - `forbid_row_mutation()` is the trigger function used by append-only tables.
 */
export class Migration20261029120000_bootstrap extends Migration {
  override name = 'Migration20261029120000_bootstrap';

  override up(): void {
    this.addSql('REVOKE ALL ON SCHEMA public FROM PUBLIC;');
    this.addSql('GRANT USAGE ON SCHEMA public TO wallet_app;');
    this.addSql(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO wallet_app;',
    );
    this.addSql(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO wallet_app;',
    );
    this.addSql(`
      CREATE FUNCTION forbid_row_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% on %.% is forbidden: rows are append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
          USING ERRCODE = 'restrict_violation';
      END;
      $$;
    `);
  }

  override down(): void {
    this.addSql('DROP FUNCTION IF EXISTS forbid_row_mutation();');
    this.addSql(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM wallet_app;',
    );
    this.addSql(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE ON TABLES FROM wallet_app;',
    );
    this.addSql('REVOKE USAGE ON SCHEMA public FROM wallet_app;');
    this.addSql('GRANT USAGE ON SCHEMA public TO PUBLIC;');
  }
}
