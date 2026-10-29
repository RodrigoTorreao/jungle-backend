import { describe, expect, test } from 'bun:test';
import {
  ConcurrencyConflictError,
  ForbiddenError,
  InvariantBreachError,
  ProviderMismatchError,
  ResourceNotFoundError,
  TransientInfrastructureError,
} from '../../../src/application/errors';
import { TRUSTED } from '../../../src/application/ports/identity';
import {
  type AppLogger,
  type Metrics,
  noopMetrics,
} from '../../../src/application/ports/observability';
import type {
  ReconciliationReader,
  ReconciliationSnapshot,
  UnitOfWork,
} from '../../../src/application/ports/persistence';
import { assertMayActFor, mayReadProvider } from '../../../src/application/services/authorization';
import { withTransientRetry } from '../../../src/application/services/transient-retry';
import { ProcessWagerTransactionUseCase } from '../../../src/application/use-cases/process-wager-transaction';
import { ReconcileWalletUseCase } from '../../../src/application/use-cases/reconcile-wallet';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction-kind';

const fastPolicy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 };
const lockTimeout = () => new TransientInfrastructureError(FailureCode.LockTimeout, 'lock timeout');

describe('withTransientRetry', () => {
  test('retries transient failures and returns the eventual result', async () => {
    let calls = 0;
    const result = await withTransientRetry(async () => {
      calls += 1;
      if (calls < 3) throw calls === 1 ? lockTimeout() : new ConcurrencyConflictError('w', 1);
      return 'ok';
    }, fastPolicy);
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  test('gives up after maxAttempts with the transient error', async () => {
    let calls = 0;
    const error = await withTransientRetry(async () => {
      calls += 1;
      throw lockTimeout();
    }, fastPolicy).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientInfrastructureError);
    expect(calls).toBe(3);
  });

  test('never retries a non-transient error', async () => {
    let calls = 0;
    const error = await withTransientRetry(async () => {
      calls += 1;
      throw new InvariantBreachError('broken');
    }, fastPolicy).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvariantBreachError);
    expect(calls).toBe(1);
  });
});

describe('provider authorization', () => {
  test('trusted callers and the provider itself may act; anyone else may not', () => {
    expect(() => assertMayActFor({ kind: 'trusted' }, 'provider-a')).not.toThrow();
    expect(() =>
      assertMayActFor({ kind: 'provider', providerId: 'provider-a' }, 'provider-a'),
    ).not.toThrow();
    expect(() =>
      assertMayActFor({ kind: 'provider', providerId: 'provider-b' }, 'provider-a'),
    ).toThrow(ProviderMismatchError);
    expect(() => assertMayActFor({ kind: 'backoffice', subject: 'ops' }, 'provider-a')).toThrow(
      ProviderMismatchError,
    );
  });

  test('a provider reads only its own data', () => {
    expect(mayReadProvider({ kind: 'provider', providerId: 'p1' }, 'p1')).toBe(true);
    expect(mayReadProvider({ kind: 'provider', providerId: 'p1' }, 'p2')).toBe(false);
    expect(mayReadProvider({ kind: 'backoffice', subject: 'ops' }, 'p2')).toBe(true);
  });

  test('a provider submitting for another provider is refused before touching the database', async () => {
    const untouchable: UnitOfWork = {
      run: () => {
        throw new Error('the database must not be reached');
      },
    };
    const useCase = new ProcessWagerTransactionUseCase(
      untouchable,
      { next: () => '0192f298-345e-7e38-af88-e43f851a819d' },
      { now: () => new Date('2026-10-29T12:00:00Z') },
    );
    await expect(
      useCase.execute({
        submission: {
          providerId: 'provider-a',
          externalTransactionId: 'tx-1',
          playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
          walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
          roundId: 'r',
          gameId: 'g',
          kind: WagerTransactionKind.Bet,
          money: { amount: '1.00', currency: 'BRL' },
        },
        idempotencyKey: 'provider-a:tx-1',
        principal: { kind: 'provider', providerId: 'provider-b' },
        correlationId: 'c',
        causationId: 'provider-a:tx-1',
        source: 'http',
      }),
    ).rejects.toBeInstanceOf(ProviderMismatchError);
  });
});

describe('ReconcileWalletUseCase', () => {
  const snapshot = (overrides: Partial<ReconciliationSnapshot> = {}): ReconciliationSnapshot => ({
    walletId: 'w-1',
    currency: 'BRL',
    storedBalance: '90.00',
    calculatedBalance: '90.00',
    difference: '0.00',
    balancesMatch: true,
    latestEntryMatches: true,
    checkedEntries: 2,
    ...overrides,
  });

  function setup(result: ReconciliationSnapshot | undefined) {
    const logged: { context: Record<string, unknown>; message: string }[] = [];
    let divergences = 0;
    const logger: AppLogger = {
      info: () => {},
      warn: () => {},
      error: (context, message) => logged.push({ context, message }),
    };
    const metrics: Metrics = {
      ...noopMetrics,
      reconciliationCheck: (_trigger, consistent) => {
        if (!consistent) divergences += 1;
      },
    };
    const reader: ReconciliationReader = {
      snapshot: async () => result,
      sampleWalletIds: async () => [],
    };
    return {
      useCase: new ReconcileWalletUseCase(reader, logger, metrics),
      logged,
      divergences: () => divergences,
    };
  }

  test('a consistent wallet is reported without logging or counting anything', async () => {
    const { useCase, logged, divergences } = setup(snapshot());
    const view = await useCase.execute('w-1', 'corr', TRUSTED);
    expect(view).toEqual({
      walletId: 'w-1',
      storedBalance: { amount: '90.00', currency: 'BRL' },
      calculatedBalance: { amount: '90.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
    expect(logged).toHaveLength(0);
    expect(divergences()).toBe(0);
  });

  test.each([
    ['the sum differs', { balancesMatch: false, storedBalance: '95.00', difference: '5.00' }],
    ['the latest entry does not match', { latestEntryMatches: false }],
  ])('a divergence (%s) is logged without amounts and counted', async (_case, overrides) => {
    const { useCase, logged, divergences } = setup(snapshot(overrides));
    const view = await useCase.execute('w-1', 'corr', TRUSTED);
    expect(view.consistent).toBe(false);
    expect(divergences()).toBe(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.context).toMatchObject({ walletId: 'w-1', correlationId: 'corr' });
    expect(JSON.stringify(logged[0]?.context)).not.toContain('95.00');
  });

  test('an unknown wallet is a NOT_FOUND', async () => {
    const { useCase } = setup(undefined);
    await expect(useCase.execute('w-x', 'corr', TRUSTED)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  test('only operators reconcile: a provider token is FORBIDDEN, backoffice is allowed', async () => {
    const { useCase } = setup(snapshot());
    await expect(
      useCase.execute('w-1', 'corr', { kind: 'provider', providerId: 'provider-a' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const view = await useCase.execute('w-1', 'corr', { kind: 'backoffice', subject: 'ops' });
    expect(view.consistent).toBe(true);
  });
});
