import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
  type MoneyProps,
} from '../../../src/domain/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money.from', () => {
  test.each([['0.00'], ['0.01'], ['25.00'], ['1000.10'], ['999999999999999999.99']])(
    'accepts the canonical amount %s and serializes it unchanged',
    (amount) => {
      expect(brl(amount).toJSON()).toEqual({ amount, currency: 'BRL' });
    },
  );

  test.each([
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['scientific notation', '1e3'],
    ['scientific notation with decimals', '2.50e1'],
    ['empty string', ''],
    ['whitespace', ' 1.00'],
    ['no decimals', '25'],
    ['one decimal', '25.5'],
    ['three decimals (no implicit rounding)', '10.005'],
    ['negative', '-1.00'],
    ['explicit plus sign', '+1.00'],
    ['leading zero', '01.00'],
    ['comma separator', '1,00'],
    ['hex', '0x10'],
    ['out of numeric(20,2) range', '1000000000000000000.00'],
  ])('rejects %s (%s)', (_case, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test.each([
    ['a number amount', { amount: 25, currency: 'BRL' }],
    ['a bigint amount', { amount: 25n, currency: 'BRL' }],
    ['a missing amount', { currency: 'BRL' }],
    ['a lowercase currency', { amount: '1.00', currency: 'brl' }],
    ['a two-letter currency', { amount: '1.00', currency: 'BR' }],
    ['a four-letter currency', { amount: '1.00', currency: 'BRLL' }],
    ['an empty currency', { amount: '1.00', currency: '' }],
  ])('rejects %s', (_case, props) => {
    expect(() => Money.from(props as unknown as MoneyProps)).toThrow(InvalidMoneyError);
  });

  test('zero() is a canonical zero in the given currency', () => {
    expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(Money.zero('BRL').isZero()).toBe(true);
  });
});

describe('Money arithmetic', () => {
  test('is exact where binary floating point is not (0.10 + 0.20 = 0.30)', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  test('stays exact across many small additions', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) {
      total = total.add(brl('0.01'));
    }
    expect(total.equals(brl('10.00'))).toBe(true);
  });

  test('keeps precision at the top of the supported range', () => {
    expect(brl('999999999999999999.98').add(brl('0.01')).toJSON().amount).toBe(
      '999999999999999999.99',
    );
  });

  test('refuses to overflow the supported range', () => {
    expect(() => brl('999999999999999999.99').add(brl('0.01'))).toThrow(InvalidMoneyError);
  });

  test('subtract can produce a negative value, serialized with a sign', () => {
    const result = brl('20.00').subtract(brl('80.00'));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe('-60.00');
  });

  test('negate flips the sign and keeps the scale', () => {
    expect(brl('0.05').negate().toJSON().amount).toBe('-0.05');
    expect(brl('0.05').negate().negate().equals(brl('0.05'))).toBe(true);
    expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
  });

  test('predicates', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').isNegative()).toBe(false);
    expect(brl('9.99').isLessThan(brl('10.00'))).toBe(true);
    expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
  });

  test('toString is human readable', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
  });
});

describe('Money immutability', () => {
  test('operations return new instances and never mutate the operands', () => {
    const a = brl('10.00');
    const b = brl('2.50');
    const sum = a.add(b);

    expect(sum).not.toBe(a);
    expect(a.toJSON().amount).toBe('10.00');
    expect(b.toJSON().amount).toBe('2.50');
  });

  test('instances are frozen', () => {
    const money = brl('1.00') as unknown as { currency: string };
    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      money.currency = 'USD';
    }).toThrow(TypeError);
  });
});

describe('Money currency conflicts', () => {
  test.each([
    ['add', () => brl('1.00').add(usd('1.00'))],
    ['subtract', () => brl('1.00').subtract(usd('1.00'))],
    ['isLessThan', () => brl('1.00').isLessThan(usd('1.00'))],
  ])('%s across currencies throws CurrencyMismatchError', (_op, run) => {
    expect(run).toThrow(CurrencyMismatchError);
  });

  test('equals across currencies is false, not an error', () => {
    expect(brl('1.00').equals(usd('1.00'))).toBe(false);
  });
});
