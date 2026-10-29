import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { HealthController } from './health/health.controller';
import { WageringController } from './wagering/wagering.controller';
import { WalletsController } from './wallets/wallets.controller';

@Module({
  controllers: [HealthController, WalletsController, WageringController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class HttpApiModule {}
