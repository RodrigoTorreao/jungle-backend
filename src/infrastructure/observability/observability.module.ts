import { Global, Module } from '@nestjs/common';
import { APP_LOGGER, METRICS } from '../../application/ports/observability';
import { NestAppLogger } from './app-logger';
import { PromMetrics } from './metrics';

@Global()
@Module({
  providers: [
    { provide: METRICS, useClass: PromMetrics },
    { provide: APP_LOGGER, useClass: NestAppLogger },
  ],
  exports: [METRICS, APP_LOGGER],
})
export class ObservabilityModule {}
