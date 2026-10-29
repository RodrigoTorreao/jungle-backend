/**
 * Persistence models: plain classes mapped with EntitySchema (no decorators, no domain logic).
 * Column names follow the default underscore naming strategy (balanceAmount -> balance_amount).
 * Money columns are `decimal` and arrive as exact strings; they become `Money` in the mappers.
 */
import { EntitySchema } from '@mikro-orm/core';

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', length: 3 },
    balanceAmount: { type: 'decimal', precision: 20, scale: 2 },
    version: { type: 'integer' },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  resultBalanceAmount!: string | null;
  resultBalanceCurrency!: string | null;
  referenceAttempts!: number;
  nextAttemptAt!: Date | null;
  createdAt!: Date;
  processedAt!: Date | null;
  updatedAt!: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string', length: 64 },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'string' },
    gameId: { type: 'string' },
    kind: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'string', length: 3 },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', nullable: true },
    resultBalanceAmount: { type: 'decimal', precision: 20, scale: 2, nullable: true },
    resultBalanceCurrency: { type: 'string', length: 3, nullable: true },
    referenceAttempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime' },
    processedAt: { type: 'datetime', nullable: true },
    updatedAt: { type: 'datetime' },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  walletVersion!: number;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    walletVersion: { type: 'integer' },
    direction: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'string', length: 3 },
    balanceBefore: { type: 'decimal', precision: 20, scale: 2 },
    balanceAfter: { type: 'decimal', precision: 20, scale: 2 },
    createdAt: { type: 'datetime' },
  },
});

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true },
    messageId: { type: 'string', primary: true },
    payloadHash: { type: 'string', length: 64 },
    receivedAt: { type: 'datetime' },
    processedAt: { type: 'datetime', nullable: true },
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  eventVersion!: number;
  correlationId!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
  lastError!: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string' },
    eventType: { type: 'string' },
    eventVersion: { type: 'integer' },
    correlationId: { type: 'string' },
    payload: { type: 'json' },
    occurredAt: { type: 'datetime' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', nullable: true },
    publishedAt: { type: 'datetime', nullable: true },
    lastError: { type: 'string', nullable: true },
  },
});

export const persistenceSchemas: EntitySchema[] = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
] as EntitySchema[];
