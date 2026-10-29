import { describe, expect, test } from 'bun:test';
import {
  canonicalJson,
  hashWagerPayload,
  type WagerPayload,
} from '../../../src/application/services/payload-hasher';
import { InvalidMoneyError } from '../../../src/domain/money/money';
import { DomainValidationError } from '../../../src/domain/shared/domain-error';

const payload: WagerPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  test('sorts keys recursively and drops undefined values', () => {
    expect(canonicalJson({ b: true, a: { d: 'x', c: null }, e: undefined })).toBe(
      '{"a":{"c":null,"d":"x"},"b":true}',
    );
  });

  test('rejects numbers: amounts travel as decimal strings', () => {
    expect(() => canonicalJson({ amount: 25 })).toThrow(DomainValidationError);
  });

  test('rejects non-plain objects', () => {
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(DomainValidationError);
  });
});

describe('hashWagerPayload', () => {
  test('is a sha256 hex digest', () => {
    expect(hashWagerPayload(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('does not depend on key order', () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as WagerPayload;
    expect(hashWagerPayload(reordered)).toBe(hashWagerPayload(payload));
  });

  test('ignores transport metadata (Idempotency-Key, messageId, occurredAt)', () => {
    const withTransport = {
      ...payload,
      idempotencyKey: 'provider-a:transaction-123',
      messageId: 'msg-123',
      occurredAt: '2026-07-29T15:00:00.000Z',
    } as WagerPayload;
    expect(hashWagerPayload(withTransport)).toBe(hashWagerPayload(payload));
  });

  test.each([
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['kind', { kind: 'WIN' }],
    ['wallet', { walletId: 'another-wallet' }],
    ['round', { roundId: 'round-988' }],
    ['reference', { referenceExternalTransactionId: 'bet-1' }],
  ])('changes when the %s changes (same key + different payload = conflict)', (_field, change) => {
    expect(hashWagerPayload({ ...payload, ...change })).not.toBe(hashWagerPayload(payload));
  });

  test('an absent reference and an undefined reference hash the same', () => {
    expect(hashWagerPayload({ ...payload, referenceExternalTransactionId: undefined })).toBe(
      hashWagerPayload(payload),
    );
  });

  test('refuses to hash an invalid amount', () => {
    expect(() =>
      hashWagerPayload({ ...payload, money: { amount: '25', currency: 'BRL' } }),
    ).toThrow(InvalidMoneyError);
  });

  test('is stable across releases (golden value)', () => {
    expect(hashWagerPayload(payload)).toBe(
      new Bun.CryptoHasher('sha256')
        .update(
          '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
            '"money":{"amount":"25.00","currency":"BRL"},' +
            '"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a",' +
            '"roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
        )
        .digest('hex'),
    );
  });
});
