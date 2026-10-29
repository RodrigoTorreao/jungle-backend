import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { FailureCode } from '../../domain/wagering/failure-code';
import { applyWagerPolicy, type WagerOutcome } from '../../domain/wagering/wager-policy';
import {
  DEFAULT_REFERENCE_RETRY_POLICY,
  type ReferenceRetryPolicy,
} from '../../domain/wagering/wager-transaction';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-kind';
import type {
  PendingReferenceCandidate,
  TransactionScope,
  UnitOfWork,
  WagerTransactionReader,
} from '../ports/persistence';
import type { Clock, IdGenerator } from '../ports/system';
import {
  DEFAULT_TRANSIENT_RETRY,
  type TransientRetryPolicy,
  withTransientRetry,
} from '../services/transient-retry';
import { eventsForOutcome } from '../services/wager-events';

export type PendingResolution = 'processed' | 'rejected' | 'rescheduled' | 'skipped';

export interface PendingRunReport {
  readonly processed: number;
  readonly rejected: number;
  readonly rescheduled: number;
  readonly skipped: number;
}

/**
 * Worker for transactions parked in PENDING_REFERENCE (Desafio §7.1, ARCHITECTURE §8.4).
 *
 * Due candidates are read without locks; each one is then handled in its own SQL transaction,
 * taking the wallet lock first (same lock order as every writer) and re-checking under it, so
 * several worker instances can run at once: a candidate already handled by another one is
 * simply skipped. A found reference applies the regular WagerPolicy; a missing one reschedules
 * with exponential backoff until the attempt limit or the TTL, then rejects with
 * REFERENCE_NOT_FOUND and emits WagerTransactionRejected.
 */
export class ReprocessPendingReferencesUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly reader: WagerTransactionReader,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly policy: ReferenceRetryPolicy = DEFAULT_REFERENCE_RETRY_POLICY,
    private readonly retryPolicy: TransientRetryPolicy = DEFAULT_TRANSIENT_RETRY,
  ) {}

  async runOnce(limit: number): Promise<PendingRunReport> {
    const candidates = await this.reader.findDuePendingReferences(this.clock.now(), limit);
    const tally = { processed: 0, rejected: 0, rescheduled: 0, skipped: 0 };
    for (const candidate of candidates) {
      const resolution = await withTransientRetry(
        () => this.unitOfWork.run((scope) => this.reprocess(scope, candidate)),
        this.retryPolicy,
      );
      tally[resolution] += 1;
    }
    return tally;
  }

  private async reprocess(
    scope: TransactionScope,
    candidate: PendingReferenceCandidate,
  ): Promise<PendingResolution> {
    const now = this.clock.now();
    const wallet = await scope.wallets.lockForUpdate(candidate.walletId);
    const transaction = await scope.transactions.lockForUpdate(candidate.transactionId);
    if (
      wallet === undefined ||
      transaction === undefined ||
      transaction.status !== WagerTransactionStatus.PendingReference ||
      (transaction.nextAttemptAt !== undefined && transaction.nextAttemptAt > now) ||
      transaction.referenceExternalTransactionId === undefined
    ) {
      return 'skipped'; // handled or rescheduled by another worker meanwhile
    }

    const reference = await scope.transactions.findByExternalId(
      transaction.providerId,
      transaction.referenceExternalTransactionId,
    );
    const expectedVersion = wallet.version;
    let outcome: WagerOutcome =
      reference === undefined
        ? { status: WagerTransactionStatus.PendingReference }
        : applyWagerPolicy({
            transaction,
            wallet,
            reference,
            referenceAlreadyReversed:
              transaction.requiresReference() &&
              (await scope.transactions.hasProcessedReversal(reference.id)),
            ledgerEntryId: this.ids.next(),
            now,
            referenceRetryPolicy: this.policy,
          });

    if (outcome.status === WagerTransactionStatus.PendingReference) {
      if (!transaction.isReferenceWaitExhausted(now, this.policy)) {
        transaction.scheduleReferenceRetry(now, this.policy);
        await scope.transactions.update(transaction);
        return 'rescheduled';
      }
      transaction.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
      outcome = {
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.ReferenceNotFound,
      };
    }

    await scope.transactions.update(transaction);
    if (outcome.status === WagerTransactionStatus.Processed && outcome.ledgerEntry !== undefined) {
      await scope.ledger.append(outcome.ledgerEntry);
      await scope.wallets.update(wallet, expectedVersion);
    }
    // A chain (e.g. ROLLBACK of this REFUND) may be waiting for this transaction in turn.
    await scope.transactions.wakeUpPendingReferencing(
      wallet.id,
      transaction.providerId,
      transaction.externalTransactionId,
      now,
    );
    await scope.outbox.enqueue(
      eventsForOutcome(transaction, wallet, outcome, () => ({
        eventId: this.ids.next(),
        correlationId: transaction.idempotencyKey,
        causationId: `pending-reference:${transaction.id}`,
        occurredAt: now,
      })).map((event) => OutboxMessage.enqueue(event)),
    );
    return outcome.status === WagerTransactionStatus.Processed ? 'processed' : 'rejected';
  }
}
