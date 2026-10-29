import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { FaultInjector } from '../../src/application/ports/fault-injector';
import type { AppLogger } from '../../src/application/ports/observability';
import type { Clock } from '../../src/application/ports/system';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction';
import { createSqsClient, QueueDirectory } from '../../src/infrastructure/messaging/sqs';
import { NoopFaultInjector } from '../../src/infrastructure/system/fault-injectors';
import {
  type WagerConsumerOptions,
  WagerTransactionConsumer,
} from '../../src/interfaces/sqs/wager-transaction.consumer';
import { ids, type Persistence, clock as systemClock } from './persistence';

export const silentLogger: AppLogger = { info: () => {}, warn: () => {}, error: () => {} };

export function testSqsClient(): SQSClient {
  return createSqsClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpointUrl: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  });
}

export interface TestQueues {
  readonly directory: QueueDirectory;
  readonly input: string;
  readonly deadLetter: string;
  readonly events: string;
  url(name: string): Promise<string>;
  cleanup(): Promise<void>;
}

/**
 * Fresh FIFO queues per test file, mirroring the production topology: input queue with a
 * redrive policy to its DLQ, plus an events queue. Short visibility keeps redelivery tests fast.
 */
export async function createTestQueues(
  client: SQSClient,
  options: { maxReceiveCount?: number; visibilityTimeoutSeconds?: number } = {},
): Promise<TestQueues> {
  const suffix = ids.next().replaceAll('-', '').slice(-12);
  const names = {
    input: `wt-${suffix}.fifo`,
    deadLetter: `wt-${suffix}-dlq.fifo`,
    events: `ev-${suffix}.fifo`,
  };
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
  const { QueueUrl: dlqUrl } = await client.send(
    new CreateQueueCommand({ QueueName: names.deadLetter, Attributes: fifo }),
  );
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  await client.send(
    new CreateQueueCommand({
      QueueName: names.input,
      Attributes: {
        ...fifo,
        VisibilityTimeout: String(options.visibilityTimeoutSeconds ?? 2),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: Attributes?.QueueArn,
          maxReceiveCount: String(options.maxReceiveCount ?? 3),
        }),
      },
    }),
  );
  await client.send(new CreateQueueCommand({ QueueName: names.events, Attributes: fifo }));

  const directory = new QueueDirectory(client);
  return {
    directory,
    ...names,
    url: (name) => directory.url(name),
    cleanup: async () => {
      for (const name of Object.values(names)) {
        await client.send(new DeleteQueueCommand({ QueueUrl: await directory.url(name) }));
      }
    },
  };
}

export interface WagerMessageData extends Record<string, unknown> {
  walletId: string;
  idempotencyKey: string;
}

/** A message in the shape of Desafio §10. */
export function wagerMessage(
  data: WagerMessageData,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { messageId: string; data: WagerMessageData } {
  return {
    messageId: `msg-${ids.next()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data,
    ...overrides,
  };
}

/** Submission data for the SQS contract (`idempotencyKey` inside `data`). */
export function messageData(
  wallet: { id: string; playerId: string },
  kind: string,
  amount: string,
  overrides: Record<string, unknown> = {},
): WagerMessageData {
  const externalTransactionId = (overrides.externalTransactionId as string) ?? `tx-${ids.next()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

/** Sends a body (object or raw string). Each send gets its own SQS deduplication id. */
export async function sendMessage(
  client: SQSClient,
  queueUrl: string,
  body: unknown,
  groupId: string,
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: ids.next(),
    }),
  );
}

/** Receives (and hides) everything currently available in a queue. */
export async function drain(client: SQSClient, queueUrl: string): Promise<Message[]> {
  const all: Message[] = [];
  for (;;) {
    const { Messages = [] } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 60,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
    );
    if (Messages.length === 0) {
      return all;
    }
    all.push(...Messages);
  }
}

export async function queueDepth(client: SQSClient, queueUrl: string) {
  const { Attributes = {} } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number(Attributes.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

export function buildConsumer(
  persistence: Persistence,
  queues: TestQueues,
  options: {
    faults?: FaultInjector;
    clock?: Clock;
    useCase?: ProcessWagerTransactionUseCase;
    overrides?: Partial<WagerConsumerOptions>;
  } = {},
): WagerTransactionConsumer {
  const clock = options.clock ?? systemClock;
  return new WagerTransactionConsumer(
    queues.directory,
    options.useCase ?? new ProcessWagerTransactionUseCase(persistence.unitOfWork, ids, clock),
    clock,
    options.faults ?? new NoopFaultInjector(),
    silentLogger,
    {
      queueName: queues.input,
      deadLetterQueueName: queues.deadLetter,
      consumerName: 'wager-transactions',
      waitTimeSeconds: 1,
      maxMessages: 10,
      retryBaseSeconds: 0,
      retryMaxSeconds: 0,
      shutdownGraceMs: 10_000,
      ...options.overrides,
    },
  );
}

/** A clock tests move by hand (backoff, TTL). */
export class ManualClock implements Clock {
  constructor(private current: Date = new Date()) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
