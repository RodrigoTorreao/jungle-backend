import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export interface WalletRepository {
  /**
   * `SELECT … FOR UPDATE` on the wallet row: every other writer of this wallet waits until the
   * current transaction ends. The only way to obtain a wallet that may be modified.
   */
  lockForUpdate(walletId: string): Promise<Wallet | undefined>;
  /** @throws WalletAlreadyExistsError when the player already has a wallet in that currency */
  insert(wallet: Wallet): Promise<void>;
  /**
   * Persists balance and version, guarded by the version read under lock — a second barrier on
   * top of the row lock. @throws ConcurrencyConflictError when the row moved underneath.
   */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
  /** Persists status, outcome and retry schedule. Business columns are immutable. */
  update(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Whether a PROCESSED REFUND or ROLLBACK already points at this transaction (I-01). */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
}

export interface LedgerRepository {
  /** Append-only: there is no update or delete. */
  append(entry: WalletLedgerEntry): Promise<void>;
}

export interface OutboxRepository {
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
}

export interface InboxRepository {
  /**
   * Records the message unless (consumerName, messageId) already exists. Returns false for a
   * duplicate; a concurrent duplicate blocks on the unique index until the first one commits.
   */
  tryReceive(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}

/** Repositories bound to one SQL transaction. */
export interface TransactionScope {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly outbox: OutboxRepository;
  readonly inbox: InboxRepository;
}

/**
 * Runs `work` in a single SQL transaction: inbox, transaction, balance, ledger and outbox are
 * committed together or not at all (Desafio §11).
 */
export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

export interface LedgerPage {
  readonly entries: readonly WalletLedgerEntry[];
  readonly hasMore: boolean;
}

/** Read side: no locks, no transaction, never used to make a decision that writes. */
export interface WalletReader {
  findWallet(walletId: string): Promise<Wallet | undefined>;
  /** Newest first. `beforeVersion` is exclusive; omit it for the first page. */
  listLedger(
    walletId: string,
    page: { readonly beforeVersion: number | undefined; readonly limit: number },
  ): Promise<LedgerPage>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
export const WALLET_READER = Symbol('WalletReader');
