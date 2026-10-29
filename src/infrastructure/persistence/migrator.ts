import { MikroORM } from '@mikro-orm/postgresql';
import { createMigrationOrmOptions } from './mikro-orm.config';

export interface MigrationRunResult {
  readonly direction: 'up' | 'down';
  readonly applied: readonly string[];
}

async function withMigrator<T>(clientUrl: string, run: (orm: MikroORM) => Promise<T>): Promise<T> {
  const orm = await MikroORM.init(createMigrationOrmOptions(clientUrl));
  try {
    return await run(orm);
  } finally {
    await orm.close(true);
  }
}

/** Applies every pending migration in a single all-or-nothing transaction. */
export function migrateUp(clientUrl: string): Promise<MigrationRunResult> {
  return withMigrator(clientUrl, async (orm) => {
    const applied = await orm.migrator.up();
    return { direction: 'up', applied: applied.map((m) => m.name) };
  });
}

/** Reverts the last migration, or every migration when `all` is set. */
export function migrateDown(
  clientUrl: string,
  options: { all?: boolean } = {},
): Promise<MigrationRunResult> {
  return withMigrator(clientUrl, async (orm) => {
    const reverted = await orm.migrator.down(options.all ? { to: 0 } : undefined);
    return { direction: 'down', applied: reverted.map((m) => m.name) };
  });
}

export function listPendingMigrations(clientUrl: string): Promise<string[]> {
  return withMigrator(clientUrl, async (orm) =>
    (await orm.migrator.getPending()).map((m) => m.name),
  );
}
