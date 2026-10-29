import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ProcessWagerTransactionUseCase } from '../../../application/use-cases/process-wager-transaction';
import { GetWagerTransactionQuery } from '../../../application/use-cases/wager-transaction-queries';
import type { WagerResult, WagerTransactionView } from '../../../application/views';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wagering/wager-transaction-kind';
import { type AuthenticatedRequest, principalOf } from '../auth/auth.guard';
import { correlationIdOf, MoneyBody, parseRequest, UuidParam } from '../request';

const identifier = (max: number) => z.string().min(1).max(max);

/** HTTP contract of a submission (Desafio §9). OPENING parses here and is refused by the domain. */
export const WagerSubmissionBody = z
  .object({
    providerId: identifier(128),
    externalTransactionId: identifier(256),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: identifier(256),
    gameId: identifier(256),
    kind: z.enum(WagerTransactionKind),
    money: MoneyBody,
    referenceExternalTransactionId: identifier(256).optional(),
  })
  .strict();

const IdempotencyKeyHeader = identifier(256);

/**
 * Each persisted outcome has its own status, so a provider decides from the status alone:
 * 200 applied · 202 accepted, waiting for its reference · 422 rejected by a business rule ·
 * 500 permanently failed. Replays return the same status and body with idempotentReplay=true.
 */
const STATUS_BY_OUTCOME: Readonly<Record<WagerResult['status'], number>> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

export interface WagerResponseBody {
  readonly transactionId: string;
  readonly status: WagerResult['status'];
  readonly failureCode?: string;
  readonly balance?: WagerResult['balance'];
  readonly idempotentReplay: boolean;
}

export function toWagerResponseBody(result: WagerResult): WagerResponseBody {
  return {
    transactionId: result.transactionId,
    status: result.status,
    ...(result.failureCode === undefined ? {} : { failureCode: result.failureCode }),
    ...(result.balance === undefined ? {} : { balance: result.balance }),
    idempotentReplay: result.idempotentReplay,
  };
}

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase)
    private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(GetWagerTransactionQuery) private readonly transactions: GetWagerTransactionQuery,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WagerResponseBody> {
    const key = parseRequest(IdempotencyKeyHeader, idempotencyKey);
    const submission = parseRequest(WagerSubmissionBody, body);
    const result = await this.processWager.execute({
      submission,
      idempotencyKey: key,
      principal: principalOf(request),
      correlationId: correlationIdOf(request),
      causationId: key,
    });
    response.status(STATUS_BY_OUTCOME[result.status]);
    return toWagerResponseBody(result);
  }

  @Get('wagering/transactions/:transactionId')
  byId(
    @Param('transactionId') transactionId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<WagerTransactionView> {
    return this.transactions.byId(parseRequest(UuidParam, transactionId), principalOf(request));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<WagerTransactionView> {
    return this.transactions.byExternalId(
      parseRequest(identifier(128), providerId),
      parseRequest(identifier(256), externalTransactionId),
      principalOf(request),
    );
  }
}
