import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { QueueDirectory } from '../messaging/sqs';

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  readonly status: 'ready' | 'not-ready' | 'shutting-down';
  readonly checks: { readonly database: DependencyStatus; readonly sqs: DependencyStatus };
}

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('readiness check timed out')), CHECK_TIMEOUT_MS),
    ),
  ]);
}

/**
 * GET /health/ready (Desafio §9): PostgreSQL answers `SELECT 1` and every configured queue
 * answers `GetQueueAttributes`. Once shutdown starts it reports `shutting-down` (503) so the
 * load balancer stops routing here while in-flight work drains.
 *
 * The flag flips in `onModuleDestroy`, which Nest runs for every module before any
 * `beforeApplicationShutdown` — the hook where workers wait for in-flight messages. Flipping it
 * there instead would keep the instance "ready" for the whole drain.
 */
@Injectable()
export class ReadinessProbe implements OnModuleDestroy {
  private shuttingDown = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly queues: QueueDirectory,
    private readonly queueNames: readonly string[],
  ) {}

  onModuleDestroy(): void {
    this.shuttingDown = true;
  }

  async check(): Promise<ReadinessReport> {
    const [database, sqs] = await Promise.all([this.database(), this.sqs()]);
    const status = this.shuttingDown
      ? 'shutting-down'
      : database === 'up' && sqs === 'up'
        ? 'ready'
        : 'not-ready';
    return { status, checks: { database, sqs } };
  }

  private async database(): Promise<DependencyStatus> {
    try {
      await withTimeout(this.orm.em.fork().execute('SELECT 1'));
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async sqs(): Promise<DependencyStatus> {
    try {
      await withTimeout(
        Promise.all(
          this.queueNames.map(async (name) =>
            this.queues.client.send(
              new GetQueueAttributesCommand({
                QueueUrl: await this.queues.url(name),
                AttributeNames: ['QueueArn'],
              }),
            ),
          ),
        ),
      );
      return 'up';
    } catch {
      return 'down';
    }
  }
}
