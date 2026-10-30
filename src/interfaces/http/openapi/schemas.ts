import { z } from 'zod';
import { FailureCode } from '../../../domain/wagering/failure-code';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wagering/wager-transaction-kind';
import { LedgerDirection } from '../../../domain/wallet/ledger-direction';

/**
 * Response shapes of the HTTP API, as zod schemas: the single source of the OpenAPI document
 * (`spec.ts`) and of the contract test, which validates real responses against them. Strict, so
 * an extra or missing field in a response breaks the test instead of silently drifting.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime();

export const MoneyResponse = z
  .object({
    amount: z.string().regex(/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict()
  .meta({ id: 'Money', description: 'Decimal string with exactly 2 places; never a JSON number.' });

export const WalletResponse = z
  .object({ id: uuid, playerId: uuid, balance: MoneyResponse, version: z.int().min(1) })
  .strict()
  .meta({ id: 'Wallet' });

export const LedgerEntryResponse = z
  .object({
    id: uuid,
    transactionId: uuid,
    direction: z.enum(LedgerDirection),
    money: MoneyResponse,
    balanceBefore: MoneyResponse,
    balanceAfter: MoneyResponse,
    walletVersion: z.int().min(1),
    createdAt: timestamp,
  })
  .strict()
  .meta({ id: 'LedgerEntry' });

export const LedgerPageResponse = z
  .object({
    items: z.array(LedgerEntryResponse),
    nextCursor: z.string().nullable().describe('Opaque; pass back as `cursor` for the next page'),
  })
  .strict()
  .meta({ id: 'LedgerPage' });

const DecidedStatus = z.enum([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.PendingReference,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export const WagerResponse = z
  .object({
    transactionId: uuid,
    status: DecidedStatus,
    failureCode: z.enum(FailureCode).optional(),
    balance: MoneyResponse.optional().describe('Balance when the outcome was decided'),
    idempotentReplay: z
      .boolean()
      .describe('true when this is the stored outcome of an earlier identical submission'),
  })
  .strict()
  .meta({ id: 'WagerOutcome' });

export const WagerTransactionResponse = z
  .object({
    transactionId: uuid,
    providerId: z.string(),
    externalTransactionId: z.string(),
    walletId: uuid,
    playerId: uuid,
    roundId: z.string(),
    gameId: z.string(),
    kind: z.enum(WagerTransactionKind),
    money: MoneyResponse,
    referenceExternalTransactionId: z.string().nullable(),
    referenceTransactionId: uuid.nullable(),
    status: z.enum(WagerTransactionStatus),
    failureCode: z.enum(FailureCode).nullable(),
    balance: MoneyResponse.nullable(),
    createdAt: timestamp,
    processedAt: timestamp.nullable(),
  })
  .strict()
  .meta({ id: 'WagerTransaction' });

export const ReconciliationResponse = z
  .object({
    walletId: uuid,
    storedBalance: MoneyResponse,
    calculatedBalance: MoneyResponse,
    difference: MoneyResponse,
    consistent: z.boolean(),
    checkedEntries: z.int().min(0),
  })
  .strict()
  .meta({ id: 'Reconciliation' });

export const ProblemResponse = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.int(),
    code: z.string().describe('Stable machine-readable code (ARCHITECTURE §9)'),
    detail: z.string(),
    retryable: z.boolean().describe('true: resend the same request unchanged (Retry-After)'),
    instance: z.string(),
    correlationId: z.string(),
    errors: z.array(z.object({ path: z.string(), message: z.string() }).strict()).optional(),
  })
  .strict()
  .meta({ id: 'Problem', description: 'RFC 9457 problem details' });

export const LiveResponse = z
  .object({ status: z.literal('ok') })
  .strict()
  .meta({ id: 'Live' });

const DependencyStatus = z.enum(['up', 'down']);
export const ReadinessResponse = z
  .object({
    status: z.enum(['ready', 'not-ready', 'shutting-down']),
    checks: z.object({ database: DependencyStatus, sqs: DependencyStatus }).strict(),
  })
  .strict()
  .meta({ id: 'Readiness' });
