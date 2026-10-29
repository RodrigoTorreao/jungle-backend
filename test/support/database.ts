import { SQL } from 'bun';
import { TEMPLATE_DATABASE, TEST_DATABASE_PREFIX, testEnv, withDatabase } from './test-env';

export interface TestDatabase {
  readonly name: string;
  /** Schema owner: DDL and direct SQL used to probe constraints. */
  readonly ownerUrl: string;
  /** Least-privilege runtime role, exactly what the app uses. */
  readonly appUrl: string;
  drop(): Promise<void>;
}

function quoteIdent(identifier: string): string {
  if (!/^[a-z0-9_]+$/.test(identifier)) {
    throw new Error(`Refusing to quote unexpected identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

async function withAdmin<T>(run: (admin: SQL) => Promise<T>): Promise<T> {
  const admin = new SQL(testEnv.adminUrl, { max: 1 });
  try {
    return await run(admin);
  } finally {
    await admin.close();
  }
}

/**
 * Creates an isolated database for one test file.
 * By default it is cloned from the migrated template (fast); pass `empty: true` to get a
 * database with no migrations applied (used by the migration tests themselves).
 */
export async function createTestDatabase(options: { empty?: boolean } = {}): Promise<TestDatabase> {
  const name = `${TEST_DATABASE_PREFIX}${Bun.randomUUIDv7().replaceAll('-', '').slice(-16)}`;
  const template = options.empty ? '' : ` TEMPLATE ${quoteIdent(TEMPLATE_DATABASE)}`;
  await withAdmin((admin) =>
    admin.unsafe(`CREATE DATABASE ${quoteIdent(name)}${template} OWNER wallet_owner`),
  );
  return {
    name,
    ownerUrl: withDatabase(testEnv.ownerUrl, name),
    appUrl: withDatabase(testEnv.appUrl, name),
    drop: () =>
      withAdmin((admin) =>
        admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`),
      ),
  };
}

/** Drops leftovers from interrupted runs and recreates the empty template database. */
export async function resetTemplateDatabase(): Promise<string> {
  await withAdmin(async (admin) => {
    const stale: { datname: string }[] = await admin`
      SELECT datname FROM pg_database WHERE datname LIKE ${`${TEST_DATABASE_PREFIX}%`}`;
    for (const { datname } of stale) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(datname)} WITH (FORCE)`);
    }
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(TEMPLATE_DATABASE)} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${quoteIdent(TEMPLATE_DATABASE)} OWNER wallet_owner`);
  });
  return withDatabase(testEnv.ownerUrl, TEMPLATE_DATABASE);
}
