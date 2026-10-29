import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money/money';
import { InvariantViolationError } from '../../../src/domain/shared/domain-error';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import type { WagerOutcome } from '../../../src/domain/wagering/wager-policy';
import { InvalidTransactionStateError } from '../../../src/domain/wagering/wager-transaction';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wagering/wager-transaction-kind';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import { apply, brl, openWallet, submit } from '../../support/domain-fixtures';

function processedBet(wallet: Wallet, amount: string, externalId = `bet-${amount}`) {
  const bet = submit(wallet, Kind.Bet, amount, { externalTransactionId: externalId });
  expect(apply(bet, wallet).status).toBe(Status.Processed);
  return bet;
}

function expectRejected(outcome: WagerOutcome, code: FailureCode): void {
  expect(outcome).toEqual({ status: Status.Rejected, failureCode: code });
}

describe('BET', () => {
  test('debits the wallet and produces one DEBIT entry', () => {
    const wallet = openWallet('100.00');
    const bet = submit(wallet, Kind.Bet, '25.00');
    const outcome = apply(bet, wallet);

    expect(outcome.status).toBe(Status.Processed);
    const entry = outcome.status === Status.Processed ? outcome.ledgerEntry : undefined;
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(entry?.transactionId).toBe(bet.id);
    expect(wallet.balance.equals(brl('75.00'))).toBe(true);
    expect(bet.resultBalance?.equals(brl('75.00'))).toBe(true);
    expect(wallet.version).toBe(2);
  });

  test('mandatory scenario: 100.00 and two bets of 80.00 → one processed, one rejected', () => {
    const wallet = openWallet('100.00');
    const first = submit(wallet, Kind.Bet, '80.00');
    const second = submit(wallet, Kind.Bet, '80.00');

    expect(apply(first, wallet).status).toBe(Status.Processed);
    expectRejected(apply(second, wallet), FailureCode.InsufficientFunds);

    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(second.resultBalance?.equals(brl('20.00'))).toBe(true);
    expect(wallet.version).toBe(2);
  });

  test('a rejected bet leaves balance and version untouched', () => {
    const wallet = openWallet('10.00');
    expectRejected(apply(submit(wallet, Kind.Bet, '10.01'), wallet), FailureCode.InsufficientFunds);
    expect(wallet.balance.equals(brl('10.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });
});

describe('WIN and LOSS', () => {
  test('WIN credits the wallet', () => {
    const wallet = openWallet('10.00');
    const outcome = apply(submit(wallet, Kind.Win, '40.00'), wallet);
    expect(outcome.status).toBe(Status.Processed);
    expect(wallet.balance.equals(brl('50.00'))).toBe(true);
  });

  test('WIN can reference the BET of the same round', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '10.00');
    const win = submit(wallet, Kind.Win, '30.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(apply(win, wallet, { reference: bet }).status).toBe(Status.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.equals(brl('120.00'))).toBe(true);
  });

  test('LOSS records the result without moving the balance or the version', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '10.00');
    const loss = submit(wallet, Kind.Loss, '0.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const outcome = apply(loss, wallet, { reference: bet });

    expect(outcome).toEqual({ status: Status.Processed, ledgerEntry: undefined });
    expect(wallet.balance.equals(brl('90.00'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(loss.resultBalance?.equals(brl('90.00'))).toBe(true);
  });

  test('a round result pointing at something other than a BET is a reference mismatch', () => {
    const wallet = openWallet('100.00');
    const win = submit(wallet, Kind.Win, '5.00');
    apply(win, wallet);
    const loss = submit(wallet, Kind.Loss, '0.00', {
      referenceExternalTransactionId: win.externalTransactionId,
    });
    expectRejected(apply(loss, wallet, { reference: win }), FailureCode.ReferenceMismatch);
  });
});

describe('REFUND', () => {
  test('credits back a processed BET', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '25.00');
    const refund = submit(wallet, Kind.Refund, '25.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const outcome = apply(refund, wallet, { reference: bet });

    expect(outcome.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
  });

  test('only references a BET', () => {
    const wallet = openWallet('100.00');
    const win = submit(wallet, Kind.Win, '5.00');
    apply(win, wallet);
    const refund = submit(wallet, Kind.Refund, '5.00', {
      referenceExternalTransactionId: win.externalTransactionId,
    });
    expectRejected(
      apply(refund, wallet, { reference: win }),
      FailureCode.ReferenceKindNotReversible,
    );
  });

  test('must match the referenced amount exactly (no partial reversal)', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '25.00');
    const refund = submit(wallet, Kind.Refund, '24.99', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expectRejected(apply(refund, wallet, { reference: bet }), FailureCode.ReversalAmountMismatch);
    expect(wallet.balance.equals(brl('75.00'))).toBe(true);
  });

  test('cannot reverse the same BET twice (any reversal kind, I-01)', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '25.00');
    const refund = submit(wallet, Kind.Refund, '25.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expectRejected(
      apply(refund, wallet, { reference: bet, alreadyReversed: true }),
      FailureCode.ReferenceAlreadyReversed,
    );
    expect(wallet.balance.equals(brl('75.00'))).toBe(true);
  });

  test('a rejected reference cannot be reversed', () => {
    const wallet = openWallet('10.00');
    const bet = submit(wallet, Kind.Bet, '50.00');
    expectRejected(apply(bet, wallet), FailureCode.InsufficientFunds);
    const refund = submit(wallet, Kind.Refund, '50.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expectRejected(apply(refund, wallet, { reference: bet }), FailureCode.ReferenceNotProcessed);
    expect(wallet.balance.equals(brl('10.00'))).toBe(true);
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits it back', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '30.00');
    const rollback = submit(wallet, Kind.Rollback, '30.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const outcome = apply(rollback, wallet, { reference: bet });
    expect(outcome.status === Status.Processed && outcome.ledgerEntry?.direction).toBe(
      LedgerDirection.Credit,
    );
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
  });

  test('of a WIN debits it back', () => {
    const wallet = openWallet('100.00');
    const win = submit(wallet, Kind.Win, '40.00');
    apply(win, wallet);
    const rollback = submit(wallet, Kind.Rollback, '40.00', {
      referenceExternalTransactionId: win.externalTransactionId,
    });
    const outcome = apply(rollback, wallet, { reference: win });
    expect(outcome.status === Status.Processed && outcome.ledgerEntry?.direction).toBe(
      LedgerDirection.Debit,
    );
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
  });

  test('of a REFUND debits the refunded amount back', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '20.00');
    const refund = submit(wallet, Kind.Refund, '20.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    apply(refund, wallet, { reference: bet });
    const rollback = submit(wallet, Kind.Rollback, '20.00', {
      referenceExternalTransactionId: refund.externalTransactionId,
    });
    expect(apply(rollback, wallet, { reference: refund }).status).toBe(Status.Processed);
    expect(wallet.balance.equals(brl('80.00'))).toBe(true);
  });

  test('that would overdraw is rejected with a code distinct from INSUFFICIENT_FUNDS', () => {
    const wallet = openWallet('0.00');
    const win = submit(wallet, Kind.Win, '50.00');
    apply(win, wallet);
    processedBet(wallet, '45.00');
    const rollback = submit(wallet, Kind.Rollback, '50.00', {
      referenceExternalTransactionId: win.externalTransactionId,
    });

    expectRejected(apply(rollback, wallet, { reference: win }), FailureCode.ReversalWouldOverdraw);
    expect(wallet.balance.equals(brl('5.00'))).toBe(true);
    expect(rollback.resultBalance?.equals(brl('5.00'))).toBe(true);
  });

  test.each([
    ['LOSS', Kind.Loss, '0.00'],
    ['ROLLBACK', Kind.Rollback, '10.00'],
  ])('of a %s is not reversible', (_name, kind, amount) => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '10.00');
    const target = submit(wallet, kind, amount, {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    apply(target, wallet, { reference: bet });
    const rollback = submit(wallet, Kind.Rollback, amount === '0.00' ? '1.00' : amount, {
      referenceExternalTransactionId: target.externalTransactionId,
    });
    expectRejected(
      apply(rollback, wallet, { reference: target }),
      FailureCode.ReferenceKindNotReversible,
    );
  });
});

describe('references', () => {
  test('a missing reference parks the transaction as PENDING_REFERENCE', () => {
    const wallet = openWallet('100.00');
    const refund = submit(wallet, Kind.Refund, '10.00', {
      referenceExternalTransactionId: 'not-yet',
    });
    expect(apply(refund, wallet)).toEqual({ status: Status.PendingReference });
    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.nextAttemptAt).toBeDefined();
    expect(wallet.version).toBe(1);
  });

  test('a parked transaction is processed once the reference arrives', () => {
    const wallet = openWallet('100.00');
    const refund = submit(wallet, Kind.Refund, '10.00', {
      referenceExternalTransactionId: 'late-bet',
    });
    apply(refund, wallet);
    const bet = processedBet(wallet, '10.00', 'late-bet');

    expect(apply(refund, wallet, { reference: bet }).status).toBe(Status.Processed);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
  });

  test('a reference that is itself still pending keeps the transaction waiting', () => {
    const wallet = openWallet('100.00');
    const refund = submit(wallet, Kind.Refund, '10.00', {
      referenceExternalTransactionId: 'bet-0',
    });
    apply(refund, wallet);
    const rollback = submit(wallet, Kind.Rollback, '10.00', {
      referenceExternalTransactionId: refund.externalTransactionId,
    });
    expect(apply(rollback, wallet, { reference: refund })).toEqual({
      status: Status.PendingReference,
    });
  });

  test.each([
    ['another round', { roundId: 'round-other' }, FailureCode.ReferenceMismatch],
    // a different player is caught first, by the wallet ownership check
    ['another player', { playerId: 'player-other' }, FailureCode.WalletPlayerMismatch],
  ])('a reversal from %s is rejected', (_case, overrides, expectedCode) => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '10.00');
    const refund = submit(wallet, Kind.Refund, '10.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
      ...overrides,
    });
    expectRejected(apply(refund, wallet, { reference: bet }), expectedCode);
    expect(wallet.balance.equals(brl('90.00'))).toBe(true);
  });

  test('a reference in another wallet is a mismatch', () => {
    const walletA = openWallet('100.00');
    const walletB = openWallet('100.00');
    const betOnA = processedBet(walletA, '10.00');
    const refundOnB = submit(walletB, Kind.Refund, '10.00', {
      referenceExternalTransactionId: betOnA.externalTransactionId,
    });
    expectRejected(apply(refundOnB, walletB, { reference: betOnA }), FailureCode.ReferenceMismatch);
  });

  test('a reference that does not carry the requested external id is a programming error', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '10.00');
    const refund = submit(wallet, Kind.Refund, '10.00', {
      referenceExternalTransactionId: 'other',
    });
    expect(() => apply(refund, wallet, { reference: bet })).toThrow(InvariantViolationError);
  });
});

describe('wallet-level validations', () => {
  test('player not owning the wallet is rejected', () => {
    const wallet = openWallet('100.00');
    expectRejected(
      apply(submit(wallet, Kind.Bet, '1.00', { playerId: 'intruder' }), wallet),
      FailureCode.WalletPlayerMismatch,
    );
  });

  test('operation currency different from the wallet currency is rejected', () => {
    const wallet = openWallet('100.00');
    const bet = submit(wallet, Kind.Bet, '1.00', {
      money: Money.from({ amount: '1.00', currency: 'USD' }),
    });
    expectRejected(apply(bet, wallet), FailureCode.CurrencyMismatch);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
  });

  test('applying the policy to a terminal transaction is a programming error', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '1.00');
    expect(() => apply(bet, wallet)).toThrow(InvalidTransactionStateError);
    expect(wallet.balance.equals(brl('99.00'))).toBe(true);
  });

  test('a transaction for another wallet is a programming error', () => {
    const walletA = openWallet('100.00');
    const walletB = openWallet('100.00');
    expect(() => apply(submit(walletA, Kind.Bet, '1.00'), walletB)).toThrow(
      InvariantViolationError,
    );
  });
});
