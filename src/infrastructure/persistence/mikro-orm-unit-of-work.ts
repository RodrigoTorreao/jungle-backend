import type { MikroORM } from '@mikro-orm/postgresql';
import type { FaultInjector } from '../../application/ports/fault-injector';
import type { TransactionScope, UnitOfWork } from '../../application/ports/persistence';
import type { Clock } from '../../application/ports/system';
import { NoopFaultInjector } from '../system/fault-injectors';
import { translateDatabaseError } from './database-errors';
import { createTransactionScope } from './repositories';

export interface UnitOfWorkOptions {
  /** How long a writer waits for a wallet row lock before giving up (transient, retryable). */
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

/**
 * One SQL transaction per call, at READ COMMITTED (ADR-004): after the wallet row lock is
 * granted, every statement sees the latest committed state. Deferred constraint triggers
 * (balance == ledger) run at COMMIT; their failure surfaces here, translated.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly clock: Clock,
    private readonly options: UnitOfWorkOptions,
    private readonly faults: FaultInjector = new NoopFaultInjector(),
  ) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(`SET LOCAL lock_timeout = '${this.options.lockTimeoutMs}ms'`);
        await em.execute(`SET LOCAL statement_timeout = '${this.options.statementTimeoutMs}ms'`);
        const result = await work(createTransactionScope(em, this.clock));
        this.faults.hit('before-commit');
        return result;
      });
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
