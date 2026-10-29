import { type DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from './infrastructure/config/app-config';
import { ConfigModule } from './infrastructure/config/config.module';
import { LoggerModule } from './infrastructure/observability/logger.module';
import { DatabaseModule } from './infrastructure/persistence/database.module';
import { HttpApiModule } from './interfaces/http/http-api.module';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule,
        DatabaseModule.forRoot(),
        HttpApiModule,
      ],
    };
  }
}
