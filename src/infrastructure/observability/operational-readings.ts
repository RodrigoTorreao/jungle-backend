import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { QueueDirectory } from '../messaging/sqs';
import type { OperationalReadings } from './metrics';

/** Gauge sources: cheap aggregate queries on partial indexes, and one SQS attribute call. */
export class DatabaseAndQueueReadings implements OperationalReadings {
  constructor(
    private readonly orm: MikroORM,
    private readonly queues: QueueDirectory,
    private readonly deadLetterQueue: string,
  ) {}

  async outboxBacklog(): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const [row] = await this.orm.em.fork().execute<{ pending: number; age: number | null }[]>(
      `SELECT count(*)::int AS pending,
              EXTRACT(EPOCH FROM now() - min(occurred_at))::float8 AS age
         FROM outbox_messages
        WHERE published_at IS NULL`,
    );
    return { pending: row?.pending ?? 0, oldestAgeSeconds: Math.max(row?.age ?? 0, 0) };
  }

  async pendingReferences(): Promise<number> {
    const [row] = await this.orm.em
      .fork()
      .execute<{ pending: number }[]>(
        `SELECT count(*)::int AS pending FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`,
      );
    return row?.pending ?? 0;
  }

  async deadLetterDepth(): Promise<number> {
    const { Attributes } = await this.queues.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.queues.url(this.deadLetterQueue),
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
  }
}
