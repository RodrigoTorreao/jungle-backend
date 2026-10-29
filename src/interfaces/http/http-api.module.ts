import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  APP_LOGGER,
  type AppLogger,
  METRICS,
  type Metrics,
} from '../../application/ports/observability';
import {
  RECONCILIATION_READER,
  type ReconciliationReader,
  UNIT_OF_WORK,
  type UnitOfWork,
  WAGER_TRANSACTION_READER,
  WALLET_READER,
  type WagerTransactionReader,
  type WalletReader,
} from '../../application/ports/persistence';
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator } from '../../application/ports/system';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction';
import { ReconcileWalletUseCase } from '../../application/use-cases/reconcile-wallet';
import { GetWagerTransactionQuery } from '../../application/use-cases/wager-transaction-queries';
import { GetWalletQuery, ListWalletLedgerQuery } from '../../application/use-cases/wallet-queries';
import { AuthGuard } from './auth/auth.guard';
import { HealthController } from './health/health.controller';
import { WageringController } from './wagering/wagering.controller';
import { WalletsController } from './wallets/wallets.controller';

/** Use cases are framework-free classes; Nest only wires them to their ports here. */
@Module({
  controllers: [HealthController, WalletsController, WageringController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    {
      provide: CreateWalletUseCase,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        new CreateWalletUseCase(uow, ids, clock),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        new ProcessWagerTransactionUseCase(uow, ids, clock),
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
      provide: GetWalletQuery,
      inject: [WALLET_READER],
      useFactory: (reader: WalletReader) => new GetWalletQuery(reader),
    },
    {
      provide: ListWalletLedgerQuery,
      inject: [WALLET_READER],
      useFactory: (reader: WalletReader) => new ListWalletLedgerQuery(reader),
    },
  ],
})
export class HttpApiModule {}
