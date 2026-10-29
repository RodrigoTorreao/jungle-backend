import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProcessWagerTransactionUseCase } from '../../../application/use-cases/process-wager-transaction';
import { GetWagerTransactionQuery } from '../../../application/use-cases/wager-transaction-queries';
import type { WagerResult, WagerTransactionView } from '../../../application/views';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-kind';
import { logContext } from '../../../infrastructure/observability/log-context';
import { identifier, WagerSubmissionBody } from '../../contracts/wager-submission';
import { processWagerTraced } from '../../traced-wager-processing';
import { type AuthenticatedRequest, principalOf } from '../auth/auth.guard';
import { correlationIdOf, parseRequest, UuidParam } from '../request';

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
    logContext.assign({ walletId: submission.walletId, providerId: submission.providerId });
    const result = await processWagerTraced(this.processWager, {
      submission,
      idempotencyKey: key,
      principal: principalOf(request),
      correlationId: correlationIdOf(request),
      causationId: key,
      source: 'http',
    });
    logContext.assign({ transactionId: result.transactionId });
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
