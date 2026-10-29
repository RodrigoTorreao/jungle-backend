import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../../src/domain/money/money';
import { InvariantViolationError } from '../../../src/domain/shared/domain-error';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import {
  type CreateLedgerEntryProps,
  WalletLedgerEntry,
} from '../../../src/domain/wallet/wallet-ledger-entry';
import { brl, T0, usd } from '../../support/domain-fixtures';

const base: CreateLedgerEntryProps = {
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('75.00'),
  walletVersion: 2,
  createdAt: T0,
};

describe('WalletLedgerEntry.create', () => {
  test('accepts balanced debits and credits', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    const credit = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      balanceAfter: brl('125.00'),
    });
    expect(credit.isBalanced()).toBe(true);
  });

  test.each([
    ['debit with wrong after', { balanceAfter: brl('80.00') }],
    ['credit computed as debit', { direction: LedgerDirection.Credit }],
    ['off by one cent', { balanceAfter: brl('75.01') }],
  ])('rejects an unbalanced entry: %s', (_case, overrides) => {
    expect(() => WalletLedgerEntry.create({ ...base, ...overrides })).toThrow(
      InvariantViolationError,
    );
  });

  test('rejects a negative resulting balance', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        balanceBefore: brl('10.00'),
        balanceAfter: brl('15.00').negate(),
      }),
    ).toThrow(InvariantViolationError);
  });

  test.each([
    ['zero amount', { money: brl('0.00'), balanceAfter: brl('100.00') }],
    ['version 0', { walletVersion: 0 }],
    ['fractional version', { walletVersion: 1.5 }],
    ['empty transaction id', { transactionId: '' }],
  ])('rejects %s', (_case, overrides) => {
    expect(() => WalletLedgerEntry.create({ ...base, ...overrides })).toThrow();
  });

  test('mixing currencies is a currency conflict', () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: usd('25.00') })).toThrow(
      CurrencyMismatchError,
    );
  });

  test('entries are structurally immutable', () => {
    const entry = WalletLedgerEntry.create(base) as unknown as { walletVersion: number };
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      entry.walletVersion = 99;
    }).toThrow(TypeError);
  });

  test('rehydrate does not re-validate persisted data', () => {
    const entry = WalletLedgerEntry.rehydrate({ ...base, balanceAfter: brl('1.00') });
    expect(entry.isBalanced()).toBe(false);
  });
});
