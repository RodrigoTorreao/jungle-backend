import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { ApplicationError } from '../../application/errors';
import { type FaultInjector, SimulatedCrashError } from '../../application/ports/fault-injector';
import { type AppLogger, type Metrics, noopMetrics } from '../../application/ports/observability';
import type { Clock } from '../../application/ports/system';
import { hashMessagePayload } from '../../application/services/payload-hasher';
import { isRetryable } from '../../application/services/transient-retry';
import type { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction';
import { DomainError } from '../../domain/shared/domain-error';
import type { QueueDirectory } from '../../infrastructure/messaging/sqs';
import { logContext } from '../../infrastructure/observability/log-context';
import { inSpan, SpanKind } from '../../infrastructure/observability/spans';
import { WagerTransactionRequestedMessage } from '../contracts/wager-submission';
import { processWagerTraced } from '../traced-wager-processing';

export interface WagerConsumerOptions {
  readonly queueName: string;
  readonly deadLetterQueueName: string;
  readonly consumerName: string;
  readonly waitTimeSeconds: number;
  readonly maxMessages: number;
  readonly retryBaseSeconds: number;
  readonly retryMaxSeconds: number;
  readonly shutdownGraceMs: number;
}

export type MessageOutcome =
  /** Committed and deleted. Includes business rejections and replays. */
  | 'acked'
  /** Cannot be represented in the domain: copied to the DLQ with the reason, then deleted. */
  | 'dead-lettered'
  /** Transient failure: left in the queue, visibility pushed out with backoff. */
  | 'retry-scheduled'
  /** Not started (shutdown, or an earlier message of its group must go first): visible again. */
  | 'released'
  /** Simulated process death: nothing acked, nothing released. */
  | 'crashed';

const MAX_REASON_LENGTH = 256;

/**
 * Consumer of `wager-transactions.fifo` (Desafio §10, ARCHITECTURE §8.2).
 *
 *  - Same use case as HTTP; the inbox row (consumerName, messageId) commits with the effects.
 *  - DeleteMessage only after COMMIT. Dying in between means a redelivery that resolves as an
 *    inbox duplicate → replay → delete: no double effect.
 *  - Failure classes: business outcomes are acked; transient errors (and unknown ones) stay in
 *    the queue with exponential visibility backoff until the redrive policy moves them to the
 *    DLQ; permanent errors (invalid message, conflicts, unknown wallet, invariant breach) go to
 *    the DLQ immediately — the DLQ is the audit trail of what the domain cannot represent.
 *  - FIFO order within a group: after a message that will be retried, the rest of its group in
 *    the batch is released instead of processed.
 */
export class WagerTransactionConsumer {
  private running: Promise<void> | undefined;
  private stopping = false;
  private receiveAbort: AbortController | undefined;
  private inReceive = false;

  constructor(
    private readonly queues: QueueDirectory,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly clock: Clock,
    private readonly faults: FaultInjector,
    private readonly logger: AppLogger,
    private readonly options: WagerConsumerOptions,
    private readonly metrics: Metrics = noopMetrics,
  ) {}

  /** Whether a ReceiveMessage (long poll) is in progress — observable for shutdown tests. */
  get receiving(): boolean {
    return this.inReceive;
  }

  start(): void {
    if (this.running !== undefined) {
      return;
    }
    this.stopping = false;
    this.running = this.loop().finally(() => {
      this.running = undefined;
    });
  }

  /**
   * Graceful stop (RF-Q06): no new receive, the long poll is aborted, in-flight messages finish,
   * received-but-not-started messages are released with visibility 0.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.receiveAbort?.abort();
    const running = this.running;
    if (running === undefined) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      running,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.options.shutdownGraceMs);
      }),
    ]);
    clearTimeout(timer);
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.stopping) {
          break;
        }
        this.logger.error({ consumer: this.options.consumerName, err: error }, 'Poll failed');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  /** Receives one batch and handles it. Exposed for deterministic tests. */
  async pollOnce(): Promise<MessageOutcome[]> {
    const queueUrl = await this.queues.url(this.options.queueName);
    this.receiveAbort = new AbortController();
    let messages: Message[];
    this.inReceive = true;
    try {
      const response = await this.queues.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: this.options.maxMessages,
          WaitTimeSeconds: this.options.waitTimeSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          MessageAttributeNames: ['All'],
        }),
        { abortSignal: this.receiveAbort.signal },
      );
      messages = response.Messages ?? [];
    } catch (error) {
      if (this.stopping && error instanceof Error && error.name === 'AbortError') {
        return [];
      }
      throw error;
    } finally {
      this.inReceive = false;
    }
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? '';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    const outcomes = await Promise.all(
      [...groups.values()].map((group) => this.handleGroup(queueUrl, group)),
    );
    return outcomes.flat();
  }

  private async handleGroup(queueUrl: string, group: Message[]): Promise<MessageOutcome[]> {
    const outcomes: MessageOutcome[] = [];
    let mustRelease = false;
    for (const message of group) {
      if (this.stopping || mustRelease) {
        await this.release(queueUrl, message);
        outcomes.push('released');
        continue;
      }
      const outcome = await logContext.run(
        {
          correlationId:
            message.MessageAttributes?.correlationId?.StringValue ?? message.MessageId ?? 'sqs',
        },
        () =>
          inSpan(
            `${this.options.queueName} process`,
            {
              kind: SpanKind.CONSUMER,
              attributes: {
                'messaging.system': 'aws_sqs',
                'messaging.destination.name': this.options.queueName,
                'messaging.message.id': message.MessageId ?? '',
              },
            },
            async (span) => {
              const result = await this.handle(queueUrl, message);
              span.setAttribute('wagering.message_outcome', result);
              return result;
            },
          ),
      );
      outcomes.push(outcome);
      if (outcome === 'crashed') {
        return outcomes; // a dead process touches nothing else
      }
      mustRelease = outcome === 'retry-scheduled';
    }
    return outcomes;
  }

  private async handle(queueUrl: string, message: Message): Promise<MessageOutcome> {
    let parsed: ReturnType<typeof WagerTransactionRequestedMessage.parse>;
    try {
      parsed = WagerTransactionRequestedMessage.parse(JSON.parse(message.Body ?? ''));
    } catch (error) {
      return this.deadLetter(queueUrl, message, 'INVALID_MESSAGE', reasonOf(error));
    }

    const { idempotencyKey, ...submission } = parsed.data;
    const context = {
      messageId: parsed.messageId,
      walletId: submission.walletId,
      providerId: submission.providerId,
    };
    logContext.assign(context);
    try {
      const result = await processWagerTraced(this.processWager, {
        submission,
        idempotencyKey,
        principal: { kind: 'trusted' },
        correlationId: message.MessageAttributes?.correlationId?.StringValue ?? parsed.messageId,
        causationId: parsed.messageId,
        source: 'sqs',
        inbox: {
          consumerName: this.options.consumerName,
          messageId: parsed.messageId,
          payloadHash: hashMessagePayload({ type: parsed.type, data: parsed.data }),
          receivedAt: this.clock.now(),
        },
      });
      logContext.assign({ transactionId: result.transactionId });
      this.faults.hit('after-commit-before-ack');
      await this.delete(queueUrl, message);
      this.logger.info(
        {
          ...context,
          transactionId: result.transactionId,
          status: result.status,
          idempotentReplay: result.idempotentReplay,
        },
        'Message processed',
      );
      return 'acked';
    } catch (error) {
      if (error instanceof SimulatedCrashError) {
        return 'crashed';
      }
      if (isPermanent(error)) {
        return this.deadLetter(queueUrl, message, codeOf(error), reasonOf(error));
      }
      return this.scheduleRetry(queueUrl, message, error, context);
    }
  }

  private async deadLetter(
    queueUrl: string,
    message: Message,
    failureCode: string,
    reason: string,
  ): Promise<MessageOutcome> {
    try {
      const deadLetterUrl = await this.queues.url(this.options.deadLetterQueueName);
      await this.queues.client.send(
        new SendMessageCommand({
          QueueUrl: deadLetterUrl,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letters',
          MessageDeduplicationId: message.MessageId ?? `dlq-${this.clock.now().getTime()}`,
          MessageAttributes: {
            failureCode: { DataType: 'String', StringValue: failureCode },
            failureReason: {
              DataType: 'String',
              StringValue: reason.slice(0, MAX_REASON_LENGTH) || failureCode,
            },
            sourceQueue: { DataType: 'String', StringValue: this.options.queueName },
          },
        }),
      );
      await this.delete(queueUrl, message);
    } catch (error) {
      // DLQ unreachable: keep the message; the redrive policy is the fallback.
      return this.scheduleRetry(queueUrl, message, error, { sqsMessageId: message.MessageId });
    }
    this.metrics.deadLetter(failureCode);
    this.logger.warn(
      { sqsMessageId: message.MessageId, failureCode },
      'Message moved to the dead-letter queue',
    );
    return 'dead-lettered';
  }

  private async scheduleRetry(
    queueUrl: string,
    message: Message,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<MessageOutcome> {
    const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
    const delaySeconds = Math.min(
      this.options.retryBaseSeconds * 2 ** Math.max(receiveCount - 1, 0),
      this.options.retryMaxSeconds,
    );
    try {
      await this.changeVisibility(queueUrl, message, delaySeconds);
    } catch {
      // The message becomes visible again when its current visibility timeout expires.
    }
    this.logger.warn(
      { ...context, code: codeOf(error), receiveCount, retryInSeconds: delaySeconds },
      'Transient failure; message will be redelivered',
    );
    return 'retry-scheduled';
  }

  private async release(queueUrl: string, message: Message): Promise<void> {
    try {
      await this.changeVisibility(queueUrl, message, 0);
    } catch {
      // Becomes visible on its own after the visibility timeout.
    }
  }

  private changeVisibility(queueUrl: string, message: Message, seconds: number) {
    return this.queues.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  private delete(queueUrl: string, message: Message) {
    return this.queues.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }
}

/** Errors no redelivery can fix. Unknown errors are treated as transient (redrive is the cap). */
function isPermanent(error: unknown): boolean {
  return error instanceof DomainError || (error instanceof ApplicationError && !isRetryable(error));
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'PROCESSING_FAILED';
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
