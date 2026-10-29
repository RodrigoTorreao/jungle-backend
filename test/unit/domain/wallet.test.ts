import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../../src/domain/money/money';
import { InvariantViolationError } from '../../../src/domain/shared/domain-error';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { InsufficientFundsError, Wallet } from '../../../src/domain/wallet/wallet';
import { WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry';
import { at, brl, nextId, openWallet, T0, usd } from '../../support/domain-fixtures';

const movement = (amount: Money, seconds = 1) => ({
  ledgerEntryId: nextId('entry'),
  transactionId: nextId('tx'),
  money: amount,
  at: at(seconds),
});

describe('Wallet.open', () => {
  test('a positive initial balance produces a version-1 OPENING credit', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w1',
      playerId: 'p1',
      initialBalance: brl('1000.00'),
      at: T0,
      opening: { transactionId: 'open-tx', ledgerEntryId: 'open-entry' },
    });

    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.equals(brl('1000.00'))).toBe(true);
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.transactionId).toBe('open-tx');
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
    expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test('a zero initial balance opens at version 1 with no ledger entry', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w2',
      playerId: 'p1',
      initialBalance: Money.zero('BRL'),
      at: T0,
      opening: { transactionId: 'open-tx', ledgerEntryId: 'open-entry' },
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  test('refuses a negative initial balance', () => {
    expect(() =>
      Wallet.open({
        id: 'w3',
        playerId: 'p1',
        initialBalance: brl('1.00').negate(),
        at: T0,
        opening: { transactionId: 'a', ledgerEntryId: 'b' },
      }),
    ).toThrow(InvariantViolationError);
  });
});

describe('Wallet movements', () => {
  test('debit and credit move the balance, bump the version and return a consistent entry', () => {
    const wallet = openWallet('100.00');

    const debit = wallet.debit(movement(brl('80.00')));
    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.balanceBefore.equals(brl('100.00'))).toBe(true);
    expect(debit.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(debit.walletVersion).toBe(wallet.version);

    const credit = wallet.credit(movement(brl('5.50'), 2));
    expect(wallet.balance.equals(brl('25.50'))).toBe(true);
    expect(wallet.version).toBe(3);
    expect(credit.balanceBefore.equals(debit.balanceAfter)).toBe(true);
    expect(wallet.updatedAt).toEqual(at(2));
  });

  test('debiting the whole balance down to zero is allowed', () => {
    const wallet = openWallet('10.00');
    wallet.debit(movement(brl('10.00')));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('a debit beyond the balance throws and leaves the wallet untouched', () => {
    const wallet = openWallet('20.00');
    expect(() => wallet.debit(movement(brl('20.01')))).toThrow(InsufficientFundsError);
    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('canDebit reflects the available balance', () => {
    const wallet = openWallet('20.00');
    expect(wallet.canDebit(brl('20.00'))).toBe(true);
    expect(wallet.canDebit(brl('20.01'))).toBe(false);
  });

  test('a movement in another currency throws CurrencyMismatchError', () => {
    const wallet = openWallet('20.00');
    expect(() => wallet.credit(movement(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(movement(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('zero or negative movements are rejected', () => {
    const wallet = openWallet('20.00');
    expect(() => wallet.credit(movement(brl('0.00')))).toThrow(InvariantViolationError);
    expect(() => wallet.credit(movement(brl('1.00').negate()))).toThrow(InvariantViolationError);
    expect(wallet.version).toBe(1);
  });

  test('the ledger of a wallet rebuilds its balance (balance == Σ credits − Σ debits)', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w-ledger',
      playerId: 'p1',
      initialBalance: brl('50.00'),
      at: T0,
      opening: { transactionId: 'open', ledgerEntryId: 'open-entry' },
    });
    const entries: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];
    entries.push(wallet.debit(movement(brl('12.34'))));
    entries.push(wallet.credit(movement(brl('7.66'))));
    entries.push(wallet.debit(movement(brl('45.32'))));

    const rebuilt = entries.reduce(
      (sum, entry) =>
        entry.direction === LedgerDirection.Credit
          ? sum.add(entry.money)
          : sum.subtract(entry.money),
      Money.zero('BRL'),
    );
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(entries.map((entry) => entry.walletVersion)).toEqual([1, 2, 3, 4]);
  });
});

describe('Wallet.rehydrate', () => {
  test('rebuilds persisted state without re-validating it', () => {
    const wallet = Wallet.rehydrate({
      id: 'w9',
      playerId: 'p9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 17,
      createdAt: T0,
      updatedAt: at(60),
    });
    expect(wallet.version).toBe(17);
    expect(wallet.balance.equals(brl('42.00'))).toBe(true);
    expect(wallet.updatedAt).toEqual(at(60));

    wallet.debit(movement(brl('2.00')));
    expect(wallet.version).toBe(18);
  });
});
