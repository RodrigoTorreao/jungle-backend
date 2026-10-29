import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CreateWalletUseCase } from '../../../application/use-cases/create-wallet';
import {
  GetWalletQuery,
  ListWalletLedgerQuery,
} from '../../../application/use-cases/wallet-queries';
import type { LedgerPageView, WalletView } from '../../../application/views';
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
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Req() request: Request): Promise<WalletView> {
    const input = parseRequest(CreateWalletBody, body);
    return this.createWallet.execute({ ...input, correlationId: correlationIdOf(request) });
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.getWallet.execute(parseRequest(UuidParam, walletId));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query() query: unknown): Promise<LedgerPageView> {
    const params = parseRequest(LedgerQueryParams, query);
    return this.listLedger.execute({
      walletId: parseRequest(UuidParam, walletId),
      cursor: params.cursor,
      limit: params.limit,
    });
  }
}
