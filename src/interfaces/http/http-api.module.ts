import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  UNIT_OF_WORK,
  type UnitOfWork,
  WALLET_READER,
  type WalletReader,
} from '../../application/ports/persistence';
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator } from '../../application/ports/system';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet';
import { GetWalletQuery, ListWalletLedgerQuery } from '../../application/use-cases/wallet-queries';
import { AuthGuard } from './auth/auth.guard';
import { HealthController } from './health/health.controller';
import { WalletsController } from './wallets/wallets.controller';

/** Use cases are framework-free classes; Nest only wires them to their ports here. */
@Module({
  controllers: [HealthController, WalletsController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    {
      provide: CreateWalletUseCase,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        new CreateWalletUseCase(uow, ids, clock),
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
