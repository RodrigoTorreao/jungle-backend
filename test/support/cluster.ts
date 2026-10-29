import net from 'node:net';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import type { TestDatabase } from './database';
import type { TestQueues } from './sqs';
import { waitFor } from './wait-for';

const PROJECT_ROOT = join(import.meta.dir, '..', '..');

/** One real application process (`bun src/main.ts`), as a separate instance of the service. */
export interface Instance {
  readonly name: string;
  readonly baseUrl: string;
  readonly process: Subprocess<'ignore', 'pipe', 'pipe'>;
  /** JSON log lines written to stdout, parsed. */
  readonly logs: Record<string, unknown>[];
  readonly exited: Promise<number>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function collectLines(stream: ReadableStream<Uint8Array>, into: Record<string, unknown>[]) {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line.startsWith('{')) {
        try {
          into.push(JSON.parse(line));
        } catch {
          // not a log line
        }
      }
      newline = buffered.indexOf('\n');
    }
  }
}

/** Environment of an instance wired to the test database and test queues. */
export function instanceEnv(
  db: TestDatabase,
  queues: TestQueues,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    APP_ROLES: 'all',
    DATABASE_URL: db.appUrl,
    DATABASE_POOL_MAX: '10',
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
    AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    SQS_WAGER_TRANSACTIONS_QUEUE: queues.input,
    SQS_WAGER_TRANSACTIONS_DLQ: queues.deadLetter,
    SQS_EVENTS_QUEUE: queues.events,
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_RETRY_BASE_SECONDS: '1',
    SQS_RETRY_MAX_SECONDS: '2',
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '200',
    SHUTDOWN_GRACE_MS: '10000',
    ...overrides,
  };
}

/** Spawns an instance and waits until GET /health/ready answers 200. */
export async function startInstance(name: string, env: Record<string, string>): Promise<Instance> {
  const port = await freePort();
  const child = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env, PORT: String(port) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const logs: Record<string, unknown>[] = [];
  void collectLines(child.stdout, logs);
  void collectLines(child.stderr, logs);
  const instance: Instance = {
    name,
    baseUrl: `http://127.0.0.1:${port}`,
    process: child,
    logs,
    exited: child.exited,
  };
  await waitFor(
    async () => {
      if (child.exitCode !== null) {
        throw new Error(`instance ${name} exited during boot (${child.exitCode})`);
      }
      const response = await fetch(`${instance.baseUrl}/health/ready`).catch(() => undefined);
      return response?.status === 200;
    },
    { timeoutMs: 30_000, intervalMs: 200, description: `instance ${name} ready` },
  );
  return instance;
}

/** SIGKILL: no shutdown hook runs, exactly like a crashed container. */
export async function killInstance(instance: Instance): Promise<void> {
  instance.process.kill('SIGKILL');
  await instance.exited;
}

export async function stopInstance(instance: Instance): Promise<void> {
  if (instance.process.exitCode === null && instance.process.signalCode === null) {
    instance.process.kill('SIGTERM');
  }
  await Promise.race([instance.exited, Bun.sleep(15_000)]);
  if (instance.process.exitCode === null && instance.process.signalCode === null) {
    instance.process.kill('SIGKILL');
    await instance.exited;
  }
}

export function isDead(instance: Instance): boolean {
  return instance.process.exitCode !== null || instance.process.signalCode !== null;
}
