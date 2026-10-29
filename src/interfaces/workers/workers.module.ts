import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { FAULT_INJECTOR, type FaultInjector } from '../../application/ports/fault-injector';
import {
  APP_LOGGER,
  type AppLogger,
  METRICS,
  type Metrics,
} from '../../application/ports/observability';
import { CLOCK, type Clock } from '../../application/ports/system';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction';
import { PublishOutboxUseCase } from '../../application/use-cases/publish-outbox';
import { ReconcileSampleUseCase } from '../../application/use-cases/reconcile-sample';
import { ReprocessPendingReferencesUseCase } from '../../application/use-cases/reprocess-pending-references';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config/app-config';
import { QueueDirectory } from '../../infrastructure/messaging/sqs';
import { logContext } from '../../infrastructure/observability/log-context';
import { WagerTransactionConsumer } from '../sqs/wager-transaction.consumer';
import { PollingWorker } from './polling-worker';

const OUTBOX_WORKER = Symbol('OutboxWorker');
const PENDING_REFERENCE_WORKER = Symbol('PendingReferenceWorker');
const RECONCILIATION_WORKER = Symbol('ReconciliationWorker');

/**
 * Starts the background roles this process runs (APP_ROLES) after boot, and stops them before
 * the database and SQS client close: consumers finish or release in-flight messages first.
 */
@Injectable()
export class WorkersLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WagerTransactionConsumer) private readonly consumer: WagerTransactionConsumer,
    @Inject(OUTBOX_WORKER) private readonly outbox: PollingWorker,
    @Inject(PENDING_REFERENCE_WORKER) private readonly pending: PollingWorker,
    @Inject(RECONCILIATION_WORKER) private readonly reconciliation: PollingWorker,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.roles.includes('consumer')) this.consumer.start();
    if (this.config.roles.includes('outbox-publisher')) this.outbox.start();
    if (this.config.roles.includes('pending-reference-worker')) this.pending.start();
    if (this.config.roles.includes('reconciliation-worker')) this.reconciliation.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([
      this.consumer.stop(),
      this.outbox.stop(),
      this.pending.stop(),
      this.reconciliation.stop(),
    ]);
  }
}

@Module({
  providers: [
    {
      provide: WagerTransactionConsumer,
      inject: [
        QueueDirectory,
        ProcessWagerTransactionUseCase,
        CLOCK,
        FAULT_INJECTOR,
        APP_LOGGER,
        APP_CONFIG,
        METRICS,
      ],
      useFactory: (
        queues: QueueDirectory,
        processWager: ProcessWagerTransactionUseCase,
        clock: Clock,
        faults: FaultInjector,
        logger: AppLogger,
        config: AppConfig,
        metrics: Metrics,
      ) =>
        new WagerTransactionConsumer(
          queues,
          processWager,
          clock,
          faults,
          logger,
          {
            queueName: config.sqs.wagerTransactionsQueue,
            deadLetterQueueName: config.sqs.wagerTransactionsDlq,
            consumerName: config.sqs.consumerName,
            waitTimeSeconds: config.sqs.waitTimeSeconds,
            maxMessages: config.sqs.maxMessages,
            retryBaseSeconds: config.sqs.retryBaseSeconds,
            retryMaxSeconds: config.sqs.retryMaxSeconds,
            shutdownGraceMs: config.shutdownGraceMs,
          },
          metrics,
        ),
    },
    {
      provide: OUTBOX_WORKER,
      inject: [PublishOutboxUseCase, APP_LOGGER, APP_CONFIG],
      useFactory: (useCase: PublishOutboxUseCase, logger: AppLogger, config: AppConfig) =>
        new PollingWorker(
          'outbox-publisher',
          async () => (await useCase.publishDueBatch(config.outbox.batchSize)).claimed,
          config.outbox.pollIntervalMs,
          logger,
        ),
    },
    {
      provide: PENDING_REFERENCE_WORKER,
      inject: [ReprocessPendingReferencesUseCase, APP_LOGGER, APP_CONFIG],
      useFactory: (
        useCase: ReprocessPendingReferencesUseCase,
        logger: AppLogger,
        config: AppConfig,
      ) =>
        new PollingWorker(
          'pending-reference-worker',
          async () => {
            const report = await useCase.runOnce(config.pendingReferences.batchSize);
            return report.processed + report.rejected;
          },
          config.pendingReferences.pollIntervalMs,
          logger,
        ),
    },
    {
      provide: RECONCILIATION_WORKER,
      inject: [ReconcileSampleUseCase, APP_LOGGER, APP_CONFIG],
      useFactory: (useCase: ReconcileSampleUseCase, logger: AppLogger, config: AppConfig) =>
        new PollingWorker(
          'reconciliation-worker',
          async () => {
            const report = await useCase.runOnce(logContext.current()?.correlationId ?? '');
            logger.info(
              { checked: report.checked, divergent: report.divergentWalletIds.length },
              'Sampled reconciliation finished',
            );
            return 0; // periodic: always wait a full interval before the next sample
          },
          config.reconciliation.intervalMs,
          logger,
        ),
    },
    WorkersLifecycle,
  ],
})
export class WorkersModule {}
