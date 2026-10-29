import type { EntitySchema } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { migrationsList } from './migrations';
import { persistenceSchemas } from './records';

export const MIGRATIONS_TABLE = 'mikro_orm_migrations';

/** Persistence-model schemas registered with the ORM. */
export const entitySchemas: EntitySchema[] = persistenceSchemas;

interface OrmOptionsInput {
  readonly clientUrl: string;
  readonly poolMax?: number;
  readonly entities?: EntitySchema[];
  readonly debug?: boolean;
}

/** Runtime ORM: least-privilege role, no migrator. */
export function createOrmOptions(input: OrmOptionsInput): Options {
  return defineConfig({
    clientUrl: input.clientUrl,
    entities: input.entities ?? entitySchemas,
    pool: { min: 0, max: input.poolMax ?? 10 },
    discovery: { warnWhenNoEntities: false },
    // Domain objects are mapped explicitly (EntitySchema + mappers); never let the ORM
    // implicitly flush or touch the schema at runtime.
    allowGlobalContext: false,
    ensureDatabase: false,
    debug: input.debug ?? false,
  });
}

/** Migration ORM: schema-owner role, hand-written SQL migrations registered explicitly. */
export function createMigrationOrmOptions(clientUrl: string): Options {
  return defineConfig({
    ...createOrmOptions({ clientUrl, poolMax: 1, entities: [] }),
    extensions: [Migrator],
    migrations: {
      tableName: MIGRATIONS_TABLE,
      migrationsList,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      snapshotOnMigrate: false,
      silent: true,
    },
  });
}
