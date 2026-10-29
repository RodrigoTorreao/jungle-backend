/**
 * Persistence <-> domain. Rehydration goes through each type's `rehydrate` factory, which never
 * re-validates transitions. Money crosses the boundary only as decimal strings (never number).
 */
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction-kind';
import type { LedgerDirection } from '../../domain/wallet/ledger-direction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

const money = (amount: string, currency: string) => Money.from({ amount, currency });
const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

export function walletToDomain(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: money(record.balanceAmount, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function walletToRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balanceAmount: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function transactionToDomain(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: money(record.amount, record.currency),
    referenceExternalTransactionId: orUndefined(record.referenceExternalTransactionId),
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: orUndefined(record.referenceTransactionId),
    failureCode: orUndefined(record.failureCode) as FailureCode | undefined,
    processedAt: orUndefined(record.processedAt),
    resultBalance:
      record.resultBalanceAmount === null || record.resultBalanceCurrency === null
        ? undefined
        : money(record.resultBalanceAmount, record.resultBalanceCurrency),
    referenceAttempts: record.referenceAttempts,
    nextAttemptAt: orUndefined(record.nextAttemptAt),
  });
}

/** Columns that may change after insert (the trigger refuses any other). */
export function transactionOutcomeColumns(transaction: WagerTransaction, updatedAt: Date) {
  const balance = transaction.resultBalance?.toJSON();
  return {
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    resultBalanceAmount: balance?.amount ?? null,
    resultBalanceCurrency: balance?.currency ?? null,
    referenceAttempts: transaction.referenceAttempts,
    nextAttemptAt: transaction.nextAttemptAt ?? null,
    processedAt: transaction.processedAt ?? null,
    updatedAt,
  };
}

export function transactionToRecord(transaction: WagerTransaction): WagerTransactionRecord {
  const amount = transaction.money.toJSON();
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: amount.amount,
    currency: amount.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    createdAt: transaction.createdAt,
    ...transactionOutcomeColumns(transaction, transaction.processedAt ?? transaction.createdAt),
  };
}

export function ledgerEntryToDomain(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: money(record.amount, record.currency),
    balanceBefore: money(record.balanceBefore, record.currency),
    balanceAfter: money(record.balanceAfter, record.currency),
    walletVersion: record.walletVersion,
    createdAt: record.createdAt,
  });
}

export function ledgerEntryToRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  };
}

export function inboxToDomain(record: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: record.messageId,
    consumerName: record.consumerName,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: orUndefined(record.processedAt),
  });
}

export function outboxToRecord(message: OutboxMessage): OutboxMessageRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    eventVersion: message.eventVersion,
    correlationId: message.correlationId,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
    lastError: message.lastError ?? null,
  };
}

export function outboxToDomain(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    eventVersion: record.eventVersion,
    correlationId: record.correlationId,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: orUndefined(record.nextAttemptAt),
    publishedAt: orUndefined(record.publishedAt),
    lastError: orUndefined(record.lastError),
  });
}
