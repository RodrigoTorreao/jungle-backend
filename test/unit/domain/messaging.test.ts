import { describe, expect, test } from 'bun:test';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  WalletOpened,
} from '../../../src/domain/messaging/events';
import {
  InboxMessage,
  InboxMessageAlreadyProcessedError,
} from '../../../src/domain/messaging/inbox-message';
import type { EventContext } from '../../../src/domain/messaging/integration-event';
import {
  OutboxMessage,
  OutboxMessageAlreadyPublishedError,
} from '../../../src/domain/messaging/outbox-message';
import { backoffDelayMs } from '../../../src/domain/shared/backoff';
import { InvariantViolationError } from '../../../src/domain/shared/domain-error';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction-kind';
import { apply, at, brl, nextId, openWallet, submit, T0 } from '../../support/domain-fixtures';

const ctx = (overrides: Partial<EventContext> = {}): EventContext => ({
  eventId: nextId('event'),
  correlationId: 'corr-1',
  causationId: 'provider-a:tx-1',
  occurredAt: at(1),
  ...overrides,
});

describe('InboxMessage', () => {
  test('is received unprocessed and can be marked processed once', () => {
    const inbox = InboxMessage.receive({
      messageId: 'msg-123',
      consumerName: 'wager-transactions',
      payloadHash: 'h1',
      receivedAt: T0,
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(at(1));
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(at(1));
    expect(() => inbox.markProcessed(at(2))).toThrow(InboxMessageAlreadyProcessedError);
  });

  test('detects a reused messageId with another payload', () => {
    const inbox = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'c',
      payloadHash: 'h1',
      receivedAt: T0,
    });
    expect(inbox.matchesPayload('h1')).toBe(true);
    expect(inbox.matchesPayload('h2')).toBe(false);
  });
});

describe('Integration events', () => {
  test('WalletBalanceChanged carries MoneyProps strings and the wallet version', () => {
    const wallet = openWallet('100.00');
    const bet = submit(wallet, Kind.Bet, '25.00');
    const outcome = apply(bet, wallet);
    if (outcome.status !== 'PROCESSED' || outcome.ledgerEntry === undefined) {
      throw new Error('expected a processed bet with a ledger entry');
    }
    const event = WalletBalanceChanged.from(wallet, outcome.ledgerEntry, ctx());

    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(wallet.id);
    expect(event.toJSON()).toMatchObject({
      eventType: 'WalletBalanceChanged',
      version: 1,
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'provider-a:tx-1',
      occurredAt: '2026-10-29T12:00:01.000Z',
      data: {
        walletId: wallet.id,
        transactionId: bet.id,
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('the envelope round-trips through JSON without losing information', () => {
    const wallet = openWallet('100.00');
    const loss = submit(wallet, Kind.Loss, '0.00');
    apply(loss, wallet);
    const envelope = WagerTransactionProcessed.from(loss, ctx()).toJSON();
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
    expect(envelope.data.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('causationId is omitted from the envelope when absent', () => {
    const wallet = openWallet('100.00');
    const event = WalletOpened.from(
      wallet,
      brl('100.00').toJSON(),
      ctx({ causationId: undefined }),
    );
    expect('causationId' in event.toJSON()).toBe(false);
  });

  test('event data is deeply frozen', () => {
    const wallet = openWallet('100.00');
    const event = WalletOpened.from(wallet, brl('100.00').toJSON(), ctx());
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.initialBalance)).toBe(true);
  });

  test('status-specific events refuse a transaction in the wrong status', () => {
    const wallet = openWallet('100.00');
    const pending = submit(wallet, Kind.Bet, '1.00');
    expect(() => WagerTransactionProcessed.from(pending, ctx())).toThrow(InvariantViolationError);
    expect(() => WagerTransactionRejected.from(pending, ctx())).toThrow(InvariantViolationError);
    expect(() => WagerTransactionPendingReference.from(pending, ctx())).toThrow(
      InvariantViolationError,
    );
  });

  test('rejected and pending-reference events carry their specific data', () => {
    const wallet = openWallet('10.00');
    const bet = submit(wallet, Kind.Bet, '50.00');
    apply(bet, wallet);
    expect(WagerTransactionRejected.from(bet, ctx()).data.failureCode).toBe(
      FailureCode.InsufficientFunds,
    );

    const refund = submit(wallet, Kind.Refund, '5.00', { referenceExternalTransactionId: 'later' });
    apply(refund, wallet, { now: T0 });
    const pending = WagerTransactionPendingReference.from(refund, ctx());
    expect(pending.data.referenceExternalTransactionId).toBe('later');
    expect(pending.data.nextAttemptAt).toBe('2026-10-29T12:00:01.000Z');
  });
});

describe('OutboxMessage', () => {
  const event = () => WalletOpened.from(openWallet('1.00'), brl('1.00').toJSON(), ctx());

  test('enqueue keeps the event identity and a JSON payload, due immediately', () => {
    const source = event();
    const message = OutboxMessage.enqueue(source);
    expect(message.id).toBe(source.eventId);
    expect(message.eventType).toBe('WalletOpened');
    expect(message.eventVersion).toBe(1);
    expect(message.payload).toEqual(JSON.parse(JSON.stringify(source.toJSON())));
    expect(message.isPending()).toBe(true);
    expect(message.isDue(at(1))).toBe(true);
    expect(message.isDue(T0)).toBe(false);
  });

  test('scheduleRetry backs off exponentially and keeps the last error', () => {
    const message = OutboxMessage.enqueue(event());
    message.scheduleRetry(at(10), 'BrokerUnavailable');
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(at(11));
    expect(message.isDue(at(10))).toBe(false);
    expect(message.isDue(at(11))).toBe(true);
    expect(message.lastError).toBe('BrokerUnavailable');

    message.scheduleRetry(at(11));
    expect(message.nextAttemptAt).toEqual(at(13));
    expect(message.attempts).toBe(2);
  });

  test('backoff is capped and never gives up', () => {
    const policy = { baseDelayMs: 1_000, maxDelayMs: 300_000 };
    expect(backoffDelayMs(0, policy)).toBe(1_000);
    expect(backoffDelayMs(8, policy)).toBe(256_000);
    expect(backoffDelayMs(9, policy)).toBe(300_000);
    expect(backoffDelayMs(5_000, policy)).toBe(300_000);
  });

  test('a published message cannot be published or retried again', () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(at(2));
    expect(message.isPending()).toBe(false);
    expect(message.isDue(at(100))).toBe(false);
    expect(() => message.markPublished(at(3))).toThrow(OutboxMessageAlreadyPublishedError);
    expect(() => message.scheduleRetry(at(3))).toThrow(OutboxMessageAlreadyPublishedError);
  });
});
