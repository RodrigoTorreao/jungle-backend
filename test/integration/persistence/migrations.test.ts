import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { migrationsList } from '../../../src/infrastructure/persistence/migrations';
import {
  listPendingMigrations,
  migrateDown,
  migrateUp,
} from '../../../src/infrastructure/persistence/migrator';
import { createTestDatabase, type TestDatabase } from '../../support/database';

const allMigrations = migrationsList.map((m) => m.name);

describe('migrations', () => {
  let db: TestDatabase;
  let owner: SQL;

  beforeAll(async () => {
    db = await createTestDatabase({ empty: true });
    owner = new SQL(db.ownerUrl, { max: 1 });
  });

  afterAll(async () => {
    await owner.close();
    await db.drop();
  });

  async function functionExists(signature: string): Promise<boolean> {
    const [row] = await owner`SELECT to_regprocedure(${signature}) IS NOT NULL AS exists`;
    return row.exists;
  }

  test('up -> down -> up is fully reversible', async () => {
    expect((await migrateUp(db.ownerUrl)).applied).toEqual(allMigrations);
    expect(await listPendingMigrations(db.ownerUrl)).toEqual([]);
    expect(await functionExists('forbid_row_mutation()')).toBe(true);

    expect((await migrateDown(db.ownerUrl, { all: true })).applied).toEqual(
      [...allMigrations].reverse(),
    );
    expect(await functionExists('forbid_row_mutation()')).toBe(false);
    expect(await listPendingMigrations(db.ownerUrl)).toEqual(allMigrations);

    expect((await migrateUp(db.ownerUrl)).applied).toEqual(allMigrations);
  });

  test('runtime role cannot run DDL in the public schema', async () => {
    const app = new SQL(db.appUrl, { max: 1 });
    try {
      await expect(app`CREATE TABLE intruder (id int)`).rejects.toMatchObject({ errno: '42501' });
    } finally {
      await app.close();
    }
  });

  test('owner tables are readable/writable but not deletable by the runtime role', async () => {
    await owner`CREATE TABLE grants_probe (id int PRIMARY KEY)`;
    const app = new SQL(db.appUrl, { max: 1 });
    try {
      await app`INSERT INTO grants_probe (id) VALUES (1)`;
      await app`UPDATE grants_probe SET id = 2 WHERE id = 1`;
      expect(await app`SELECT id FROM grants_probe`).toEqual([{ id: 2 }]);
      await expect(app`DELETE FROM grants_probe`).rejects.toMatchObject({ errno: '42501' });
      await expect(app`TRUNCATE grants_probe`).rejects.toMatchObject({ errno: '42501' });
    } finally {
      await app.close();
      await owner`DROP TABLE grants_probe`;
    }
  });
});
