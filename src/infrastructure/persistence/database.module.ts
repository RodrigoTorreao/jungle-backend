import { MikroORM } from '@mikro-orm/postgresql';
import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { createOrmOptions } from './mikro-orm.config';

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
      ],
      exports: [MikroORM],
    };
  }

  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
