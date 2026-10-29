import { type BackoffPolicy, nextAttemptAt } from '../shared/backoff';
import { DomainError } from '../shared/domain-error';
import type { IntegrationEvent } from './integration-event';

export class OutboxMessageAlreadyPublishedError extends DomainError {
  readonly code = 'OUTBOX_MESSAGE_ALREADY_PUBLISHED';

  constructor(id: string) {
    super(`Outbox message ${id} is already published`);
  }
}

/** 1s, 2s, 4s … capped at 5 min. No give-up: a committed event is never dropped. */
export const DEFAULT_OUTBOX_RETRY_POLICY: BackoffPolicy = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
});

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly correlationId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date | undefined;
  readonly publishedAt?: Date | undefined;
  readonly lastError?: string | undefined;
}

const MAX_ERROR_LENGTH = 500;

/**
 * An integration event waiting to be published. Enqueued in the same SQL transaction as the
 * change that produced it; a publisher marks it published only after the broker accepted it.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly eventVersion: number,
    readonly correlationId: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  /** The outbox id is the event id, so a republished message keeps a stable identity. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = Object.freeze(JSON.parse(JSON.stringify(event)) as Record<string, unknown>);
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.version,
      event.correlationId,
      payload,
      new Date(event.occurredAt.getTime()),
      0,
      new Date(event.occurredAt.getTime()),
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.eventVersion,
      state.correlationId,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    const dueAt = this._nextAttemptAt ?? this.occurredAt;
    return this.isPending() && dueAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = new Date(at.getTime());
    this._nextAttemptAt = undefined;
  }

  /** Increments attempts and pushes nextAttemptAt out with exponential backoff. */
  scheduleRetry(
    now: Date,
    error?: string,
    policy: BackoffPolicy = DEFAULT_OUTBOX_RETRY_POLICY,
  ): void {
    this.assertPending();
    this._nextAttemptAt = nextAttemptAt(now, this._attempts, policy);
    this._attempts += 1;
    this._lastError = error?.slice(0, MAX_ERROR_LENGTH);
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new OutboxMessageAlreadyPublishedError(this.id);
    }
  }
}
