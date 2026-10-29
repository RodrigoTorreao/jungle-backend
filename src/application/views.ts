import type { MoneyProps } from '../domain/money/money';
import type { LedgerDirection } from '../domain/wallet/ledger-direction';
import type { Wallet } from '../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry';

/** Read shapes returned by use cases: JSON-ready, money as MoneyProps strings. */
export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

export interface LedgerEntryView {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
  readonly createdAt: string;
}

export interface LedgerPageView {
  readonly items: readonly LedgerEntryView[];
  readonly nextCursor: string | null;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}
