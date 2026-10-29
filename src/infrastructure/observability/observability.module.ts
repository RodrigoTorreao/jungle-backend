import { MikroORM } from '@mikro-orm/postgresql';
import { Global, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_LOGGER, METRICS } from '../../application/ports/observability';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { QueueDirectory } from '../messaging/sqs';
import { NestAppLogger } from './app-logger';
import { PromMetrics, registerOperationalGauges } from './metrics';
import { DatabaseAndQueueReadings } from './operational-readings';
import { ReadinessProbe } from './readiness';
import { tracerProvider } from './tracing';

const OPERATIONAL_GAUGES = Symbol('OperationalGauges');

/** Flushes buffered spans after every other shutdown hook (no-op when tracing is off). */
@Injectable()
class TracingShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await tracerProvider?.shutdown();
  }
}

@Global()
@Module({
  providers: [
    { provide: PromMetrics, useFactory: () => new PromMetrics() },
    { provide: METRICS, useExisting: PromMetrics },
    { provide: APP_LOGGER, useClass: NestAppLogger },
    {
      provide: OPERATIONAL_GAUGES,
      inject: [PromMetrics, MikroORM, QueueDirectory, APP_CONFIG],
      useFactory: (
        metrics: PromMetrics,
        orm: MikroORM,
        queues: QueueDirectory,
        config: AppConfig,
      ) => {
        registerOperationalGauges(
          metrics.registry,
          new DatabaseAndQueueReadings(orm, queues, config.sqs.wagerTransactionsDlq),
          config.sqs.wagerTransactionsDlq,
        );
        return true;
      },
    },
    TracingShutdown,
    {
      provide: ReadinessProbe,
      inject: [MikroORM, QueueDirectory, APP_CONFIG],
      useFactory: (orm: MikroORM, queues: QueueDirectory, config: AppConfig) =>
        new ReadinessProbe(orm, queues, [
          config.sqs.wagerTransactionsQueue,
          config.sqs.wagerTransactionsDlq,
          config.sqs.eventsQueue,
        ]),
    },
  ],
  exports: [PromMetrics, METRICS, APP_LOGGER, ReadinessProbe],
})
export class ObservabilityModule {}
