import { describe, expect, test } from 'bun:test';
import {
  DomainValidationError,
  InvariantViolationError,
} from '../../../src/domain/shared/domain-error';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import {
  DEFAULT_REFERENCE_RETRY_POLICY,
  InvalidTransactionStateError,
  WagerTransaction,
} from '../../../src/domain/wagering/wager-transaction';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wagering/wager-transaction-kind';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { at, brl, openWallet, submit, T0 } from '../../support/domain-fixtures';

const wallet = openWallet('100.00');

function expectValidationCode(run: () => unknown, code: FailureCode): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainValidationError);
    expect((error as DomainValidationError).code).toBe(code);
    return;
  }
  throw new Error(`expected a DomainValidationError with code ${code}`);
}

describe('WagerTransaction.create', () => {
  test('is born PENDING with no outcome yet', () => {
    const tx = submit(wallet, Kind.Bet, '25.00');
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.resultBalance).toBeUndefined();
  });

  test('OPENING cannot be submitted by a provider', () => {
    expectValidationCode(() => submit(wallet, Kind.Opening, '10.00'), FailureCode.UnsupportedKind);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
    expectValidationCode(() => submit(wallet, kind, '10.00'), FailureCode.MissingReference);
  });

  test.each([Kind.Win, Kind.Loss])('%s may carry a reference to its bet', (kind) => {
    const tx = submit(wallet, kind, '10.00', { referenceExternalTransactionId: 'bet-1' });
    expect(tx.referenceExternalTransactionId).toBe('bet-1');
  });

  test('BET does not take a reference', () => {
    expectValidationCode(
      () => submit(wallet, Kind.Bet, '10.00', { referenceExternalTransactionId: 'bet-0' }),
      FailureCode.ValidationError,
    );
  });

  test('a transaction cannot reference itself', () => {
    expectValidationCode(
      () =>
        submit(wallet, Kind.Refund, '10.00', {
          externalTransactionId: 'same',
          referenceExternalTransactionId: 'same',
        }),
      FailureCode.ValidationError,
    );
  });

  test('LOSS accepts 0.00; every other kind needs a positive amount', () => {
    expect(submit(wallet, Kind.Loss, '0.00').money.isZero()).toBe(true);
    for (const kind of [Kind.Bet, Kind.Win]) {
      expectValidationCode(() => submit(wallet, kind, '0.00'), FailureCode.InvalidMoney);
    }
  });

  test('the internal provider id is reserved', () => {
    expectValidationCode(
      () => submit(wallet, Kind.Bet, '1.00', { providerId: 'internal' }),
      FailureCode.ValidationError,
    );
  });

  test('empty business identifiers are rejected', () => {
    expectValidationCode(
      () => submit(wallet, Kind.Bet, '1.00', { roundId: ' ' }),
      FailureCode.ValidationError,
    );
  });
});

describe('WagerTransaction transitions', () => {
  test('PENDING -> PROCESSED records the reference, time and balance snapshot', () => {
    const tx = submit(wallet, Kind.Bet, '25.00');
    tx.markProcessed(undefined, at(5), brl('75.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(at(5));
    expect(tx.resultBalance?.equals(brl('75.00'))).toBe(true);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING -> REJECTED requires a business rejection code', () => {
    const tx = submit(wallet, Kind.Bet, '25.00');
    expect(() => tx.reject(FailureCode.LockTimeout, at(1), brl('1.00'))).toThrow(
      InvariantViolationError,
    );
    tx.reject(FailureCode.InsufficientFunds, at(1), brl('1.00'));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('PENDING -> FAILED requires a permanent failure code', () => {
    const tx = submit(wallet, Kind.Bet, '25.00');
    expect(() => tx.fail(FailureCode.InsufficientFunds, at(1))).toThrow(InvariantViolationError);
    tx.fail(FailureCode.InvariantViolation, at(1));
    expect(tx.status).toBe(Status.Failed);
  });

  test('processing a reversal without a resolved reference is a programming error', () => {
    const tx = submit(wallet, Kind.Refund, '10.00', { referenceExternalTransactionId: 'bet-1' });
    expect(() => tx.markProcessed(undefined, at(1), brl('1.00'))).toThrow(InvariantViolationError);
  });

  describe('terminal states never change', () => {
    const terminal = {
      PROCESSED: () => {
        const tx = submit(wallet, Kind.Bet, '1.00');
        tx.markProcessed(undefined, at(1), brl('99.00'));
        return tx;
      },
      REJECTED: () => {
        const tx = submit(wallet, Kind.Bet, '1.00');
        tx.reject(FailureCode.InsufficientFunds, at(1), brl('0.00'));
        return tx;
      },
      FAILED: () => {
        const tx = submit(wallet, Kind.Bet, '1.00');
        tx.fail(FailureCode.InvariantViolation, at(1));
        return tx;
      },
    };

    for (const [status, make] of Object.entries(terminal)) {
      test(`${status} rejects every transition`, () => {
        const tx = make();
        expect(() => tx.markProcessed(undefined, at(2), brl('1.00'))).toThrow(
          InvalidTransactionStateError,
        );
        expect(() => tx.reject(FailureCode.InsufficientFunds, at(2), brl('1.00'))).toThrow(
          InvalidTransactionStateError,
        );
        expect(() => tx.fail(FailureCode.InvariantViolation, at(2))).toThrow(
          InvalidTransactionStateError,
        );
        expect(() => tx.markPendingReference(at(2), brl('1.00'))).toThrow(
          InvalidTransactionStateError,
        );
        expect(tx.status).toBe(status as Status);
      });
    }
  });

  test('rehydrate restores a terminal state without re-validating it', () => {
    const tx = WagerTransaction.rehydrate({
      id: 'tx-r',
      providerId: 'p',
      externalTransactionId: 'e',
      idempotencyKey: 'p:e',
      payloadHash: 'h',
      walletId: 'w',
      playerId: 'pl',
      roundId: 'r',
      gameId: 'g',
      kind: Kind.Bet,
      money: brl('1.00'),
      createdAt: T0,
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      processedAt: at(1),
      resultBalance: brl('0.50'),
      referenceAttempts: 0,
    });
    expect(tx.status).toBe(Status.Rejected);
    expect(() => tx.markProcessed(undefined, at(2), brl('1.00'))).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('PENDING_REFERENCE scheduling', () => {
  const policy = DEFAULT_REFERENCE_RETRY_POLICY;

  test('backs off exponentially and is exhausted by attempt count', () => {
    const tx = submit(wallet, Kind.Refund, '10.00', { referenceExternalTransactionId: 'bet-x' });
    tx.markPendingReference(T0, brl('100.00'));
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.nextAttemptAt).toEqual(at(1));

    const delays: number[] = [];
    let now = T0;
    while (!tx.isReferenceWaitExhausted(now, { ...policy, ttlMs: Number.POSITIVE_INFINITY })) {
      tx.scheduleReferenceRetry(now);
      delays.push(((tx.nextAttemptAt?.getTime() ?? 0) - now.getTime()) / 1000);
      now = tx.nextAttemptAt ?? now;
    }
    expect(delays).toEqual([2, 4, 8, 16, 32, 64, 128, 256, 300, 300]);
    expect(tx.referenceAttempts).toBe(policy.maxAttempts);
  });

  test('is exhausted by TTL even with attempts left', () => {
    const tx = submit(wallet, Kind.Rollback, '10.00', { referenceExternalTransactionId: 'bet-y' });
    tx.markPendingReference(T0, brl('100.00'));
    expect(tx.isReferenceWaitExhausted(at(899))).toBe(false);
    expect(tx.isReferenceWaitExhausted(at(900))).toBe(true);
  });

  test('a pending transaction can still be processed or rejected', () => {
    const tx = submit(wallet, Kind.Refund, '10.00', { referenceExternalTransactionId: 'bet-z' });
    tx.markPendingReference(T0, brl('100.00'));
    tx.reject(FailureCode.ReferenceNotFound, at(900), brl('100.00'));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.nextAttemptAt).toBeUndefined();
  });

  test('only PENDING_REFERENCE transactions can be rescheduled', () => {
    const tx = submit(wallet, Kind.Bet, '10.00');
    expect(() => tx.scheduleReferenceRetry(T0)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction queries', () => {
  test('affectsBalance is false only for LOSS', () => {
    expect(submit(wallet, Kind.Loss, '0.00').affectsBalance()).toBe(false);
    expect(submit(wallet, Kind.Win, '1.00').affectsBalance()).toBe(true);
  });

  test('requiresReference is true for REFUND and ROLLBACK', () => {
    const ref = { referenceExternalTransactionId: 'bet-1' };
    expect(submit(wallet, Kind.Refund, '1.00', ref).requiresReference()).toBe(true);
    expect(submit(wallet, Kind.Rollback, '1.00', ref).requiresReference()).toBe(true);
    expect(submit(wallet, Kind.Win, '1.00', ref).requiresReference()).toBe(false);
  });

  test('same idempotency key with a different payload hash is not a match', () => {
    const tx = submit(wallet, Kind.Bet, '1.00', { payloadHash: 'b'.repeat(64) });
    expect(tx.matchesPayload('b'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('c'.repeat(64))).toBe(false);
  });

  test('ledger direction per kind, ROLLBACK inverting its reference', () => {
    const bet = submit(wallet, Kind.Bet, '1.00');
    const win = submit(wallet, Kind.Win, '1.00');
    const refund = submit(wallet, Kind.Refund, '1.00', { referenceExternalTransactionId: 'x' });
    const rollback = submit(wallet, Kind.Rollback, '1.00', { referenceExternalTransactionId: 'x' });

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvariantViolationError);
    expect(() => submit(wallet, Kind.Loss, '0.00').ledgerDirectionFor()).toThrow(
      InvariantViolationError,
    );
  });

  test('opening() creates an internal, already processed credit', () => {
    const opening = WagerTransaction.opening({
      id: 'open-1',
      walletId: 'w-1',
      playerId: 'p-1',
      money: brl('1000.00'),
      payloadHash: 'd'.repeat(64),
      at: T0,
    });
    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.status).toBe(Status.Processed);
    expect(opening.providerId).toBe('internal');
    expect(opening.externalTransactionId).toBe('opening:w-1');
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});
