import type { MoneyProps } from '../domain/money/money';
import type { FailureCode } from '../domain/wagering/failure-code';
import type { WagerTransaction } from '../domain/wagering/wager-transaction';
import type {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wagering/wager-transaction-kind';
import type { LedgerDirection } from '../domain/wallet/ledger-direction';
import type { Wallet } from '../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry';

/** Outcome of a submission — new or replayed — exactly as the provider sees it. */
export interface WagerResult {
  readonly transactionId: string;
  readonly status: Exclude<WagerTransactionStatus, WagerTransactionStatus.Pending>;
  readonly failureCode: FailureCode | undefined;
  /** Balance observed when the outcome was decided (absent only for FAILED). */
  readonly balance: MoneyProps | undefined;
  readonly idempotentReplay: boolean;
}

export interface WagerTransactionView {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly status: WagerTransactionStatus;
  readonly failureCode: FailureCode | null;
  readonly balance: MoneyProps | null;
  readonly createdAt: string;
  readonly processedAt: string | null;
}

export interface ReconciliationView {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export function toWagerTransactionView(transaction: WagerTransaction): WagerTransactionView {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balance: transaction.resultBalance?.toJSON() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}

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
