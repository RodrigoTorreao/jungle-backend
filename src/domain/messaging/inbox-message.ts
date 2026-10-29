import { DomainError } from '../shared/domain-error';
import { assertNonEmpty } from '../shared/guards';

export class InboxMessageAlreadyProcessedError extends DomainError {
  readonly code = 'INBOX_MESSAGE_ALREADY_PROCESSED';

  constructor(consumerName: string, messageId: string) {
    super(`Inbox message ${consumerName}/${messageId} is already processed`);
  }
}

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly processedAt?: Date | undefined;
}

/**
 * Persistent dedup record for a consumed message, keyed by (consumerName, messageId).
 * Written in the same SQL transaction as the effects it guards.
 */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    assertNonEmpty(props.messageId, 'messageId');
    assertNonEmpty(props.consumerName, 'consumerName');
    assertNonEmpty(props.payloadHash, 'payloadHash');
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      new Date(props.receivedAt.getTime()),
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /** Same messageId with another payload means a producer bug, not a redelivery (I-10). */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InboxMessageAlreadyProcessedError(this.consumerName, this.messageId);
    }
    this._processedAt = new Date(at.getTime());
  }
}
