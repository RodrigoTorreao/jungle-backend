import { Global, Module } from '@nestjs/common';
import { FAULT_INJECTOR, type FaultInjector } from '../application/ports/fault-injector';
import { EVENT_PUBLISHER, type EventPublisher } from '../application/ports/messaging';
import {
  APP_LOGGER,
  type AppLogger,
  METRICS,
  type Metrics,
} from '../application/ports/observability';
import {
  RECONCILIATION_READER,
  type ReconciliationReader,
  UNIT_OF_WORK,
  type UnitOfWork,
  WAGER_TRANSACTION_READER,
  WALLET_READER,
  type WagerTransactionReader,
  type WalletReader,
} from '../application/ports/persistence';
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator } from '../application/ports/system';
import { CreateWalletUseCase } from '../application/use-cases/create-wallet';
import { ProcessWagerTransactionUseCase } from '../application/use-cases/process-wager-transaction';
import { PublishOutboxUseCase } from '../application/use-cases/publish-outbox';
import { ReconcileSampleUseCase } from '../application/use-cases/reconcile-sample';
import { ReconcileWalletUseCase } from '../application/use-cases/reconcile-wallet';
import { ReprocessPendingReferencesUseCase } from '../application/use-cases/reprocess-pending-references';
import { GetWagerTransactionQuery } from '../application/use-cases/wager-transaction-queries';
import { GetWalletQuery, ListWalletLedgerQuery } from '../application/use-cases/wallet-queries';
import { APP_CONFIG, type AppConfig } from '../infrastructure/config/app-config';

/**
 * Use cases are framework-free classes; Nest only wires them to their ports here, once, for
 * every inbound adapter (HTTP controllers, SQS consumer, workers).
 */
const useCases = [
  {
    provide: CreateWalletUseCase,
    inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
    useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) =>
      new CreateWalletUseCase(uow, ids, clock),
  },
  {
    provide: ProcessWagerTransactionUseCase,
    inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, METRICS],
    useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock, metrics: Metrics) =>
      new ProcessWagerTransactionUseCase(uow, ids, clock, metrics),
  },
  {
    provide: PublishOutboxUseCase,
    inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, FAULT_INJECTOR, METRICS],
    useFactory: (
      uow: UnitOfWork,
      publisher: EventPublisher,
      clock: Clock,
      faults: FaultInjector,
      metrics: Metrics,
    ) => new PublishOutboxUseCase(uow, publisher, clock, faults, metrics),
  },
  {
    provide: ReprocessPendingReferencesUseCase,
    inject: [UNIT_OF_WORK, WAGER_TRANSACTION_READER, ID_GENERATOR, CLOCK, METRICS],
    useFactory: (
      uow: UnitOfWork,
      reader: WagerTransactionReader,
      ids: IdGenerator,
      clock: Clock,
      metrics: Metrics,
    ) => new ReprocessPendingReferencesUseCase(uow, reader, ids, clock, undefined, metrics),
  },
  {
    provide: GetWagerTransactionQuery,
    inject: [WAGER_TRANSACTION_READER],
    useFactory: (reader: WagerTransactionReader) => new GetWagerTransactionQuery(reader),
  },
  {
    provide: ReconcileWalletUseCase,
    inject: [RECONCILIATION_READER, APP_LOGGER, METRICS],
    useFactory: (reader: ReconciliationReader, logger: AppLogger, metrics: Metrics) =>
      new ReconcileWalletUseCase(reader, logger, metrics),
  },
  {
    provide: ReconcileSampleUseCase,
    inject: [RECONCILIATION_READER, ReconcileWalletUseCase, CLOCK, APP_CONFIG],
    useFactory: (
      reader: ReconciliationReader,
      reconcile: ReconcileWalletUseCase,
      clock: Clock,
      config: AppConfig,
    ) =>
      new ReconcileSampleUseCase(reader, reconcile, clock, {
        sampleSize: config.reconciliation.sampleSize,
        recentWindowMs: config.reconciliation.intervalMs,
      }),
  },
  {
    provide: GetWalletQuery,
    inject: [WALLET_READER],
    useFactory: (reader: WalletReader) => new GetWalletQuery(reader),
  },
  {
    provide: ListWalletLedgerQuery,
    inject: [WALLET_READER],
    useFactory: (reader: WalletReader) => new ListWalletLedgerQuery(reader),
  },
];

@Global()
@Module({
  providers: useCases,
  exports: useCases.map((useCase) => useCase.provide),
})
export class UseCasesModule {}
