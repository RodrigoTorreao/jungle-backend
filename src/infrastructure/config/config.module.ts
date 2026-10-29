import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './app-config';

@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
