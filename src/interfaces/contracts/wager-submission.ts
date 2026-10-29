import { z } from 'zod';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';

export const identifier = (max: number) => z.string().min(1).max(max);

/** Money on the wire. Its exact format is enforced by Money.from (INVALID_MONEY). */
export const MoneyBody = z.object({ amount: z.string(), currency: z.string() }).strict();

/**
 * Business fields of a submission, shared by HTTP (body) and SQS (`data`). OPENING parses here
 * and is refused by the domain with UNSUPPORTED_KIND.
 */
export const WagerSubmissionFields = {
  providerId: identifier(128),
  externalTransactionId: identifier(256),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: identifier(256),
  gameId: identifier(256),
  kind: z.enum(WagerTransactionKind),
  money: MoneyBody,
  referenceExternalTransactionId: identifier(256).optional(),
};

export const WagerSubmissionBody = z.object(WagerSubmissionFields).strict();

/** SQS message of Desafio §10. `data.idempotencyKey` plays the role of the HTTP header. */
export const WagerTransactionRequestedMessage = z.object({
  messageId: identifier(256),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: z.object({ ...WagerSubmissionFields, idempotencyKey: identifier(256) }).strict(),
});

export type WagerTransactionRequested = z.output<typeof WagerTransactionRequestedMessage>;
