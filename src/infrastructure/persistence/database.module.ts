import { MikroORM } from '@mikro-orm/postgresql';
import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { UNIT_OF_WORK, WALLET_READER } from '../../application/ports/persistence';
import { CLOCK, type Clock, ID_GENERATOR } from '../../application/ports/system';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { SystemClock, UuidV7Generator } from '../system/system-adapters';
import { createOrmOptions } from './mikro-orm.config';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work';
import { MikroOrmWalletReader } from './repositories';

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
          provide: UNIT_OF_WORK,
          inject: [MikroORM, CLOCK, APP_CONFIG],
          useFactory: (orm: MikroORM, clock: Clock, config: AppConfig) =>
            new MikroOrmUnitOfWork(orm, clock, {
              lockTimeoutMs: config.database.lockTimeoutMs,
              statementTimeoutMs: config.database.statementTimeoutMs,
            }),
        },
        {
          provide: WALLET_READER,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new MikroOrmWalletReader(orm.em),
        },
      ],
      exports: [MikroORM, CLOCK, ID_GENERATOR, UNIT_OF_WORK, WALLET_READER],
    };
  }

  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
