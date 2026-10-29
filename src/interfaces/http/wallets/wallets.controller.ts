import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { CreateWalletUseCase } from '../../../application/use-cases/create-wallet';
import { ReconcileWalletUseCase } from '../../../application/use-cases/reconcile-wallet';
import {
  GetWalletQuery,
  ListWalletLedgerQuery,
} from '../../../application/use-cases/wallet-queries';
import type { LedgerPageView, ReconciliationView, WalletView } from '../../../application/views';
import { type AuthenticatedRequest, principalOf } from '../auth/auth.guard';
import { correlationIdOf, MoneyBody, parseRequest, UuidParam } from '../request';

const CreateWalletBody = z.object({ playerId: z.uuid(), initialBalance: MoneyBody }).strict();

const LedgerQueryParams = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(GetWalletQuery) private readonly getWallet: GetWalletQuery,
    @Inject(ListWalletLedgerQuery) private readonly listLedger: ListWalletLedgerQuery,
    @Inject(ReconcileWalletUseCase) private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<WalletView> {
    const input = parseRequest(CreateWalletBody, body);
    return this.createWallet.execute({
      ...input,
      correlationId: correlationIdOf(request),
      principal: principalOf(request),
    });
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.getWallet.execute(parseRequest(UuidParam, walletId));
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query() query: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<LedgerPageView> {
    const params = parseRequest(LedgerQueryParams, query);
    return this.listLedger.execute({
      walletId: parseRequest(UuidParam, walletId),
      cursor: params.cursor,
      limit: params.limit,
      principal: principalOf(request),
    });
  }

  /** Never corrects anything: reports, logs and counts divergences (RF-H07). */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconciliation(
    @Param('walletId') walletId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReconciliationView> {
    return this.reconcile.execute(
      parseRequest(UuidParam, walletId),
      correlationIdOf(request),
      principalOf(request),
    );
  }
}
