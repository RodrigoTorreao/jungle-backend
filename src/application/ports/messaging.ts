import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface PublishReport {
  /** Ids (= eventIds) the broker accepted. */
  readonly published: ReadonlySet<string>;
  /** Ids the broker refused, with the reason (kept in outbox.last_error). */
  readonly failed: ReadonlyMap<string, string>;
}

/**
 * Publishes outbox messages to the event stream. At-least-once: a message may be published again
 * after a crash, always with the same eventId (the FIFO deduplication id and the consumers' key).
 * Send failures are reported per message in `failed`.
 * @throws when the queue cannot even be resolved; every message then counts as failed
 */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishReport>;
}

export const EVENT_PUBLISHER = Symbol('EventPublisher');
