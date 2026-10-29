import { MikroORM } from '@mikro-orm/postgresql';
import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { FAULT_INJECTOR, type FaultInjector } from '../../application/ports/fault-injector';
import {
  RECONCILIATION_READER,
  UNIT_OF_WORK,
  WAGER_TRANSACTION_READER,
  WALLET_READER,
} from '../../application/ports/persistence';
import { CLOCK, type Clock, ID_GENERATOR } from '../../application/ports/system';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { ArmedFaultInjector, NoopFaultInjector } from '../system/fault-injectors';
import { SystemClock, UuidV7Generator } from '../system/system-adapters';
import { createOrmOptions } from './mikro-orm.config';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work';
import {
  MikroOrmReconciliationReader,
  MikroOrmWagerTransactionReader,
  MikroOrmWalletReader,
} from './repositories';

@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  static forRoot(): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: MikroORM,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) =>
            MikroORM.init(
              createOrmOptions({
                clientUrl: config.database.url,
                poolMax: config.database.poolMax,
              }),
            ),
        },
        { provide: CLOCK, useClass: SystemClock },
        { provide: ID_GENERATOR, useClass: UuidV7Generator },
        {
          provide: FAULT_INJECTOR,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): FaultInjector =>
            config.faults.points.length === 0
              ? new NoopFaultInjector()
              : new ArmedFaultInjector(config.faults.points, config.faults.mode),
        },
        {
          provide: UNIT_OF_WORK,
          inject: [MikroORM, CLOCK, APP_CONFIG, FAULT_INJECTOR],
          useFactory: (orm: MikroORM, clock: Clock, config: AppConfig, faults: FaultInjector) =>
            new MikroOrmUnitOfWork(
              orm,
              clock,
              {
                lockTimeoutMs: config.database.lockTimeoutMs,
                statementTimeoutMs: config.database.statementTimeoutMs,
              },
              faults,
            ),
        },
        {
          provide: WALLET_READER,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new MikroOrmWalletReader(orm.em),
        },
        {
          provide: WAGER_TRANSACTION_READER,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new MikroOrmWagerTransactionReader(orm.em),
        },
        {
          provide: RECONCILIATION_READER,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new MikroOrmReconciliationReader(orm.em),
        },
      ],
      exports: [
        MikroORM,
        CLOCK,
        ID_GENERATOR,
        FAULT_INJECTOR,
        UNIT_OF_WORK,
        WALLET_READER,
        WAGER_TRANSACTION_READER,
        RECONCILIATION_READER,
      ],
    };
  }

  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
