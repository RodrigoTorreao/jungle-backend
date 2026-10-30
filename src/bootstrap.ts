import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppConfig } from './infrastructure/config/app-config';
import { correlationMiddleware } from './infrastructure/observability/logger.module';
import { SWAGGER_UI_ASSETS, SWAGGER_UI_PREFIX } from './interfaces/http/openapi/docs.controller';
import { ProblemDetailsFilter } from './interfaces/http/problem-details.filter';

/** Builds the application without listening, so tests can boot it on an ephemeral port. */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // Before Nest's module middleware (pino-http): opens the log context of every request.
  app.use(correlationMiddleware);
  app.useStaticAssets(SWAGGER_UI_ASSETS, { prefix: SWAGGER_UI_PREFIX, index: false });
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  return app;
}
