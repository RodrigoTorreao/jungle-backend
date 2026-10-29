import { describe, expect, test } from 'bun:test';
import {
  FAILURE_CODES,
  FailureCategory,
  FailureCode,
} from '../../../src/domain/wagering/failure-code';

describe('FailureCode taxonomy', () => {
  const codes = Object.values(FailureCode);

  test('every code has a descriptor and codes are unique', () => {
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(FAILURE_CODES[code]).toBeDefined();
    }
  });

  test('only transient failures are retryable', () => {
    for (const code of codes) {
      const descriptor = FAILURE_CODES[code];
      expect(descriptor.retryable).toBe(descriptor.category === FailureCategory.Transient);
    }
  });

  test('persisted statuses follow the category', () => {
    for (const code of codes) {
      const { category, persistedAs } = FAILURE_CODES[code];
      if (persistedAs === 'FAILED') {
        expect(category).toBe(FailureCategory.Permanent);
      }
      if (persistedAs === 'REJECTED') {
        expect(category).toBe(FailureCategory.Business);
      }
    }
  });

  test('an overdrawing reversal is distinguishable from a bet without funds', () => {
    expect(FailureCode.ReversalWouldOverdraw).not.toBe(FailureCode.InsufficientFunds);
    expect(FAILURE_CODES[FailureCode.ReversalWouldOverdraw].providerAction).not.toBe(
      FAILURE_CODES[FailureCode.InsufficientFunds].providerAction,
    );
  });
});
