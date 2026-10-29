import { Money } from '../../src/domain/money/money';
import { applyWagerPolicy, type WagerOutcome } from '../../src/domain/wagering/wager-policy';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../../src/domain/wagering/wager-transaction';
import type { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { Wallet } from '../../src/domain/wallet/wallet';

export const T0 = new Date('2026-10-29T12:00:00.000Z');

export function at(secondsAfterT0: number): Date {
  return new Date(T0.getTime() + secondsAfterT0 * 1000);
}

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

let sequence = 0;
export function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export const PROVIDER = 'provider-a';
export const PLAYER = 'player-1';
export const ROUND = 'round-987';
export const GAME = 'fortune-chimp';

export function openWallet(
  balance = '100.00',
  overrides: { id?: string; playerId?: string; currency?: string } = {},
): Wallet {
  return Wallet.open({
    id: overrides.id ?? nextId('wallet'),
    playerId: overrides.playerId ?? PLAYER,
    initialBalance: Money.from({ amount: balance, currency: overrides.currency ?? 'BRL' }),
    at: T0,
    opening: { transactionId: nextId('opening-tx'), ledgerEntryId: nextId('opening-entry') },
  }).wallet;
}

export function submit(
  wallet: Wallet,
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId('ext');
  return WagerTransaction.create({
    id: nextId('tx'),
    providerId: PROVIDER,
    externalTransactionId,
    idempotencyKey: `${PROVIDER}:${externalTransactionId}`,
    payloadHash: 'a'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: ROUND,
    gameId: GAME,
    kind,
    money: brl(amount),
    createdAt: T0,
    ...overrides,
  });
}

export function apply(
  tx: WagerTransaction,
  wallet: Wallet,
  options: { reference?: WagerTransaction; alreadyReversed?: boolean; now?: Date } = {},
): WagerOutcome {
  return applyWagerPolicy({
    transaction: tx,
    wallet,
    reference: options.reference,
    referenceAlreadyReversed: options.alreadyReversed ?? false,
    ledgerEntryId: nextId('entry'),
    now: options.now ?? at(1),
  });
}
