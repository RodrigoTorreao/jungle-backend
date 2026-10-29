import { InboxMessage } from '../../domain/messaging/inbox-message';
import type { IntegrationEvent } from '../../domain/messaging/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { InvariantViolationError } from '../../domain/shared/domain-error';
import { applyWagerPolicy, type WagerOutcome } from '../../domain/wagering/wager-policy';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import {
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction-kind';
import type { Wallet } from '../../domain/wallet/wallet';
import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
  InboxPayloadMismatchError,
  WalletNotFoundError,
} from '../errors';
import type { Principal } from '../ports/identity';
import {
  type MessageSource,
  type Metrics,
  noopMetrics,
  type ProcessingOutcome,
} from '../ports/observability';
import type { TransactionScope, UnitOfWork } from '../ports/persistence';
import type { Clock, IdGenerator } from '../ports/system';
import { assertMayActFor } from '../services/authorization';
import { hashWagerPayload } from '../services/payload-hasher';
import {
  DEFAULT_TRANSIENT_RETRY,
  recordTransientFailure,
  type TransientRetryPolicy,
  withTransientRetry,
} from '../services/transient-retry';
import { eventsForOutcome } from '../services/wager-events';
import type { WagerResult } from '../views';

/** Business fields of a submission — identical for HTTP and SQS. */
export interface WagerSubmission {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
}

export interface ProcessWagerCommand {
  readonly submission: WagerSubmission;
  /** Source of truth for idempotency (HTTP header / SQS data.idempotencyKey). */
  readonly idempotencyKey: string;
  readonly principal: Principal;
  readonly correlationId: string;
  /** What caused this processing: the Idempotency-Key (HTTP) or the messageId (SQS). */
  readonly causationId: string;
  /** Present when the submission arrived as a queue message (Desafio §10). */
  readonly inbox?: InboxContext | undefined;
  /** Entry point, for metrics. */
  readonly source: MessageSource;
}

const OUTCOME_LABEL: Readonly<Record<WagerResult['status'], ProcessingOutcome>> = {
  [WagerTransactionStatus.Processed]: 'processed',
  [WagerTransactionStatus.Rejected]: 'rejected',
  [WagerTransactionStatus.PendingReference]: 'pending_reference',
  [WagerTransactionStatus.Failed]: 'failed',
};

export interface InboxContext {
  readonly consumerName: string;
  /** Producer-assigned id in the message body — stable across redeliveries and re-sends. */
  readonly messageId: string;
  /** Hash of the whole message payload, to tell a redelivery from a reused messageId. */
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

/**
 * The one use case behind `POST /wagering/transactions` and the SQS consumer (Desafio §10).
 *
 * Inside a single SQL transaction (ARCHITECTURE §8.1, §8.2):
 *   [inbox record] → lock wallet → idempotency lookup (replay or conflict) → resolve
 *   reference → WagerPolicy → persist transaction, ledger entry, wallet, outbox events →
 *   wake up transactions waiting for this one → COMMIT.
 * The inbox row commits together with the effects, so a redelivered message finds it and
 * resolves as a replay; a concurrent duplicate blocks on the inbox key until the first commits.
 * The wallet row lock serializes every writer of that wallet; READ COMMITTED makes each
 * lookup after the lock see what concurrent writers committed. Transient failures (lock
 * timeout, deadlock, duplicate-insert race) re-run the whole transaction a bounded number of
 * times; a race on the idempotency key then resolves as a replay or a conflict.
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics = noopMetrics,
    private readonly retryPolicy: TransientRetryPolicy = DEFAULT_TRANSIENT_RETRY,
  ) {}

  async execute(command: ProcessWagerCommand): Promise<WagerResult> {
    const startedAt = performance.now();
    const { kind } = command.submission;
    const elapsed = () => (performance.now() - startedAt) / 1000;
    try {
      assertMayActFor(command.principal, command.submission.providerId);
      const payloadHash = hashWagerPayload(command.submission);
      // Validate the contract before taking any lock: invalid payloads never reach the database.
      this.buildTransaction(command, payloadHash, this.clock.now());

      const result = await withTransientRetry(
        () => this.unitOfWork.run((scope) => this.process(scope, command, payloadHash)),
        this.retryPolicy,
        (failure) => recordTransientFailure(this.metrics, failure),
      );
      if (result.idempotentReplay) {
        this.metrics.idempotentReplay(command.source);
        this.metrics.processingDuration(kind, command.source, 'replay', elapsed());
      } else {
        this.metrics.transactionOutcome(kind, result.status, command.source);
        this.metrics.processingDuration(
          kind,
          command.source,
          OUTCOME_LABEL[result.status],
          elapsed(),
        );
      }
      return result;
    } catch (error) {
      const conflict =
        error instanceof IdempotencyKeyConflictError ||
        error instanceof ExternalTransactionIdConflictError;
      if (conflict) {
        this.metrics.idempotencyConflict(command.source);
      }
      this.metrics.processingDuration(
        kind,
        command.source,
        conflict ? 'conflict' : 'error',
        elapsed(),
      );
      throw error;
    }
  }

  private async process(
    scope: TransactionScope,
    command: ProcessWagerCommand,
    payloadHash: string,
  ): Promise<WagerResult> {
    const { submission } = command;
    if (command.inbox !== undefined) {
      // Lock order: inbox → wallet → transactions (ARCHITECTURE §6).
      await this.receiveInbox(scope, command.inbox);
    }
    const wallet = await scope.wallets.lockForUpdate(submission.walletId);

    const existing = await scope.transactions.findByIdempotencyKey(
      submission.providerId,
      command.idempotencyKey,
    );
    if (existing !== undefined) {
      if (!existing.matchesPayload(payloadHash)) {
        throw new IdempotencyKeyConflictError(submission.providerId, command.idempotencyKey);
      }
      return resultOf(existing, true);
    }
    if (wallet === undefined) {
      throw new WalletNotFoundError(submission.walletId);
    }
    const sameExternalId = await scope.transactions.findByExternalId(
      submission.providerId,
      submission.externalTransactionId,
    );
    if (sameExternalId !== undefined) {
      throw new ExternalTransactionIdConflictError(
        submission.providerId,
        submission.externalTransactionId,
      );
    }

    const now = this.clock.now();
    const transaction = this.buildTransaction(command, payloadHash, now);
    const reference =
      transaction.referenceExternalTransactionId === undefined
        ? undefined
        : await scope.transactions.findByExternalId(
            submission.providerId,
            transaction.referenceExternalTransactionId,
          );
    const referenceAlreadyReversed =
      reference !== undefined && transaction.requiresReference()
        ? await scope.transactions.hasProcessedReversal(reference.id)
        : false;

    const expectedVersion = wallet.version;
    const outcome = applyWagerPolicy({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      now,
    });

    await scope.transactions.insert(transaction);
    if (outcome.status === WagerTransactionStatus.Processed && outcome.ledgerEntry !== undefined) {
      await scope.ledger.append(outcome.ledgerEntry);
      await scope.wallets.update(wallet, expectedVersion);
    }
    if (transaction.isTerminal()) {
      await scope.transactions.wakeUpPendingReferencing(
        wallet.id,
        transaction.providerId,
        transaction.externalTransactionId,
        now,
      );
    }
    await scope.outbox.enqueue(
      this.eventsFor(transaction, wallet, outcome, command, now).map((event) =>
        OutboxMessage.enqueue(event),
      ),
    );
    return resultOf(transaction, false);
  }

  /**
   * Records the message in the inbox. A duplicate (redelivery, or a concurrent copy that just
   * committed) falls through to the idempotency lookup and becomes a replay; the same messageId
   * with another payload is refused.
   */
  private async receiveInbox(scope: TransactionScope, context: InboxContext): Promise<void> {
    const message = InboxMessage.receive(context);
    message.markProcessed(this.clock.now());
    if (await scope.inbox.tryReceive(message)) {
      return;
    }
    this.metrics.inboxDuplicate(context.consumerName);
    const existing = await scope.inbox.find(context.consumerName, context.messageId);
    if (existing !== undefined && !existing.matchesPayload(context.payloadHash)) {
      throw new InboxPayloadMismatchError(context.consumerName, context.messageId);
    }
  }

  private buildTransaction(
    command: ProcessWagerCommand,
    payloadHash: string,
    now: Date,
  ): WagerTransaction {
    const { submission } = command;
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: submission.providerId,
      externalTransactionId: submission.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: submission.walletId,
      playerId: submission.playerId,
      roundId: submission.roundId,
      gameId: submission.gameId,
      kind: submission.kind,
      money: Money.from(submission.money),
      referenceExternalTransactionId: submission.referenceExternalTransactionId,
      createdAt: now,
    });
  }

  private eventsFor(
    transaction: WagerTransaction,
    wallet: Wallet,
    outcome: WagerOutcome,
    command: ProcessWagerCommand,
    now: Date,
  ): IntegrationEvent<unknown>[] {
    return eventsForOutcome(transaction, wallet, outcome, () => ({
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      causationId: command.causationId,
      occurredAt: now,
    }));
  }
}

/** The stored outcome, replayed verbatim — including the balance observed back then (RN-10). */
export function resultOf(transaction: WagerTransaction, idempotentReplay: boolean): WagerResult {
  if (transaction.status === WagerTransactionStatus.Pending) {
    throw new InvariantViolationError(`Transaction ${transaction.id} was persisted as PENDING`);
  }
  return {
    transactionId: transaction.id,
    status: transaction.status,
    failureCode: transaction.failureCode,
    balance: transaction.resultBalance?.toJSON(),
    idempotentReplay,
  };
}
