/**
 * Sprint 0 spike (ADR-001): proves the MikroORM features the design relies on work under Bun
 * against a real PostgreSQL:
 *  - EntitySchema mapping of a plain persistence class (no decorators),
 *  - em.transactional() + LockMode.PESSIMISTIC_WRITE serializing concurrent writers,
 *  - SET LOCAL lock_timeout inside a transaction surfacing as SQLSTATE 55P03,
 *  - numeric(20,2) round-tripping as an exact string (ADR-002).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EntitySchema, LockMode } from '@mikro-orm/core';
import { DriverException, LockWaitTimeoutException, MikroORM } from '@mikro-orm/postgresql';
import { SQL } from 'bun';
import { createOrmOptions } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { deferred } from '../../support/wait-for';

class SpikeCounter {
  id!: string;
  value!: number;
  amount!: string;
}

const SpikeCounterSchema = new EntitySchema<SpikeCounter>({
  class: SpikeCounter,
  tableName: 'spike_counters',
  properties: {
    id: { type: 'string', primary: true },
    value: { type: 'integer' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
  },
});

const CONCURRENT_WRITERS = 20;

describe('MikroORM spike', () => {
  let db: TestDatabase;
  let orm: MikroORM;

  beforeAll(async () => {
    db = await createTestDatabase();
    const owner = new SQL(db.ownerUrl, { max: 1 });
    await owner`CREATE TABLE spike_counters (
      id text PRIMARY KEY,
      value integer NOT NULL,
      amount numeric(20,2) NOT NULL
    )`;
    await owner`INSERT INTO spike_counters VALUES ('hot', 0, 0), ('lock-probe', 0, 0)`;
    await owner.close();

    orm = await MikroORM.init(
      createOrmOptions({
        clientUrl: db.appUrl,
        poolMax: CONCURRENT_WRITERS + 2,
        entities: [SpikeCounterSchema],
      }),
    );
  });

  afterAll(async () => {
    await orm.close(true);
    await db.drop();
  });

  test('pessimistic write lock serializes concurrent read-modify-write (no lost update)', async () => {
    await Promise.all(
      Array.from({ length: CONCURRENT_WRITERS }, () =>
        orm.em.fork().transactional(async (em) => {
          const counter = await em.findOneOrFail(SpikeCounter, 'hot', {
            lockMode: LockMode.PESSIMISTIC_WRITE,
          });
          counter.value += 1;
        }),
      ),
    );

    const counter = await orm.em.fork().findOneOrFail(SpikeCounter, 'hot');
    expect(counter.value).toBe(CONCURRENT_WRITERS);
  });

  test('lock_timeout set inside the transaction surfaces as SQLSTATE 55P03', async () => {
    const lockHeld = deferred();
    const release = deferred();

    const holder = orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(SpikeCounter, 'lock-probe', { lockMode: LockMode.PESSIMISTIC_WRITE });
      lockHeld.resolve();
      await release.promise;
    });

    try {
      await lockHeld.promise;
      const contender = orm.em.fork().transactional(async (em) => {
        await em.execute(`SET LOCAL lock_timeout = '100ms'`);
        await em.findOneOrFail(SpikeCounter, 'lock-probe', {
          lockMode: LockMode.PESSIMISTIC_WRITE,
        });
      });

      // Finding: MikroORM 7's PostgreSQL converter does not map 55P03 to
      // LockWaitTimeoutException. Transient-error classification must use the SQLSTATE.
      const error = await contender.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DriverException);
      expect(error).not.toBeInstanceOf(LockWaitTimeoutException);
      expect(error).toMatchObject({ code: '55P03' });
    } finally {
      release.resolve();
      await holder;
    }
  });

  test('numeric(20,2) round-trips as an exact decimal string, never a float', async () => {
    const largest = '999999999999999999.99';
    await orm.em.fork().transactional(async (em) => {
      const counter = await em.findOneOrFail(SpikeCounter, 'hot', {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });
      counter.amount = largest;
    });

    const counter = await orm.em.fork().findOneOrFail(SpikeCounter, 'hot');
    expect(counter.amount).toBe(largest);
    expect(typeof counter.amount).toBe('string');

    const [sum] = await orm.em.fork().execute(`SELECT (0.10::numeric(20,2) + 0.20) AS total`);
    expect(sum?.total).toBe('0.30');
  });
});
