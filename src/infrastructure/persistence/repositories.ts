/**
 * MikroORM adapters for the persistence ports.
 *
 * Strategy (ADR-013): the ORM manages the transaction, the connection, the mapping metadata and
 * the queries, but financial writes are explicit statements (`insert`, `nativeUpdate`) issued in
 * a fixed order — never implicit dirty-checking at flush time. Reads bypass the identity map so a
 * row re-read after an explicit write is never served stale from memory.
 */
import { type EntityManager, IsolationLevel, LockMode } from '@mikro-orm/postgresql';
import {
  ConcurrencyConflictError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
} from '../../application/errors';
import type {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  OutboxRepository,
  ReconciliationReader,
  ReconciliationSnapshot,
  TransactionScope,
  WagerTransactionReader,
  WagerTransactionRepository,
  WalletReader,
  WalletRepository,
} from '../../application/ports/persistence';
import type { Clock } from '../../application/ports/system';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { FailureCode } from '../../domain/wagering/failure-code';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction-kind';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { isUniqueViolation } from './database-errors';
import {
  inboxToDomain,
  ledgerEntryToDomain,
  ledgerEntryToRecord,
  outboxToRecord,
  transactionOutcomeColumns,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
} from './mappers';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

const fresh = { disableIdentityMap: true } as const;

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockForUpdate(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id: walletId },
      { ...fresh, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return record ? walletToDomain(record) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRecord, walletToRecord(wallet));
    } catch (error) {
      if (isUniqueViolation(error, 'uq_wallets_player_currency')) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      {
        balanceAmount: wallet.balance.toJSON().amount,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(wallet.id, expectedVersion);
    }
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly clock: Clock,
  ) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    try {
      await this.em.insert(WagerTransactionRecord, transactionToRecord(transaction));
    } catch (error) {
      // Two writers on *different* wallets raced for the same key or external id: the loser
      // retries the whole transaction and then sees the winner (replay or conflict).
      if (
        isUniqueViolation(error, 'uq_tx_idempotency') ||
        isUniqueViolation(error, 'uq_tx_external_id')
      ) {
        throw new TransientInfrastructureError(
          FailureCode.ConcurrencyConflict,
          `Concurrent submission of ${transaction.providerId}/${transaction.externalTransactionId}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async update(transaction: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: transaction.id },
      transactionOutcomeColumns(transaction, this.clock.now()),
    );
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { id }, fresh);
    return record ? transactionToDomain(record) : undefined;
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { providerId, idempotencyKey },
      fresh,
    );
    return record ? transactionToDomain(record) : undefined;
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { providerId, externalTransactionId },
      fresh,
    );
    return record ? transactionToDomain(record) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, ledgerEntryToRecord(entry));
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length > 0) {
      await this.em.insertMany(OutboxMessageRecord, messages.map(outboxToRecord));
    }
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryReceive(message: InboxMessage): Promise<boolean> {
    const result = await this.em.execute<{ affectedRows: number }>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt ?? null,
      ],
      'run',
    );
    return result.affectedRows === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageRecord, { consumerName, messageId }, fresh);
    return record ? inboxToDomain(record) : undefined;
  }
}

export function createTransactionScope(em: EntityManager, clock: Clock): TransactionScope {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em, clock),
    ledger: new MikroOrmLedgerRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    inbox: new MikroOrmInboxRepository(em),
  };
}

export class MikroOrmWalletReader implements WalletReader {
  constructor(private readonly em: EntityManager) {}

  async findWallet(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.fork().findOne(WalletRecord, { id: walletId }, fresh);
    return record ? walletToDomain(record) : undefined;
  }

  async listLedger(
    walletId: string,
    page: { readonly beforeVersion: number | undefined; readonly limit: number },
  ): Promise<LedgerPage> {
    const records = await this.em
      .fork()
      .find(
        LedgerEntryRecord,
        page.beforeVersion === undefined
          ? { walletId }
          : { walletId, walletVersion: { $lt: page.beforeVersion } },
        { ...fresh, orderBy: { walletVersion: 'desc' }, limit: page.limit + 1 },
      );
    return {
      entries: records.slice(0, page.limit).map(ledgerEntryToDomain),
      hasMore: records.length > page.limit,
    };
  }
}

export class MikroOrmWagerTransactionReader implements WagerTransactionReader {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.fork().findOne(WagerTransactionRecord, { id }, fresh);
    return record ? transactionToDomain(record) : undefined;
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em
      .fork()
      .findOne(WagerTransactionRecord, { providerId, externalTransactionId }, fresh);
    return record ? transactionToDomain(record) : undefined;
  }
}

interface ReconciliationRow {
  wallet_id: string;
  currency: string;
  stored_balance: string;
  calculated_balance: string;
  difference: string;
  balances_match: boolean;
  latest_entry_matches: boolean;
  checked_entries: number;
}

/**
 * Rebuilds the balance from the full ledger inside a READ ONLY, REPEATABLE READ transaction:
 * wallet and entries come from the same snapshot, and no lock blocks concurrent writers.
 * Every comparison runs in PostgreSQL `numeric` — nothing passes through a JS number.
 */
export class MikroOrmReconciliationReader implements ReconciliationReader {
  constructor(private readonly em: EntityManager) {}

  async snapshot(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    const rows = await this.em.fork().transactional(
      (em) =>
        em.execute<ReconciliationRow[]>(
          `WITH ledger AS (
             SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)
                      AS calculated,
                    COUNT(*)::int AS entries
               FROM wallet_ledger_entries
              WHERE wallet_id = ?
           ),
           latest AS (
             SELECT balance_after, wallet_version
               FROM wallet_ledger_entries
              WHERE wallet_id = ?
              ORDER BY wallet_version DESC
              LIMIT 1
           )
           SELECT w.id AS wallet_id,
                  w.currency,
                  w.balance_amount::text AS stored_balance,
                  ledger.calculated::numeric(20,2)::text AS calculated_balance,
                  (w.balance_amount - ledger.calculated)::numeric(20,2)::text AS difference,
                  w.balance_amount = ledger.calculated AS balances_match,
                  CASE
                    WHEN latest.wallet_version IS NULL THEN w.version = 1
                    ELSE latest.balance_after = w.balance_amount AND latest.wallet_version = w.version
                  END AS latest_entry_matches,
                  ledger.entries AS checked_entries
             FROM wallets w
            CROSS JOIN ledger
             LEFT JOIN latest ON TRUE
            WHERE w.id = ?`,
          [walletId, walletId, walletId],
        ),
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      walletId: row.wallet_id,
      currency: row.currency,
      storedBalance: row.stored_balance,
      calculatedBalance: row.calculated_balance,
      difference: row.difference,
      balancesMatch: row.balances_match,
      latestEntryMatches: row.latest_entry_matches,
      checkedEntries: row.checked_entries,
    };
  }
}
