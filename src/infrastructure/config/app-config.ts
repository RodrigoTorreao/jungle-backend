import { z } from 'zod';

export const APP_ROLES = [
  'api',
  'consumer',
  'outbox-publisher',
  'pending-reference-worker',
] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const APP_CONFIG = Symbol('APP_CONFIG');

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

const appRolesSchema = z
  .string()
  .transform((raw) =>
    raw.trim() === 'all'
      ? [...APP_ROLES]
      : raw
          .split(',')
          .map((role) => role.trim())
          .filter((role) => role.length > 0),
  )
  .pipe(z.array(z.enum(APP_ROLES)).min(1));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_ROLES: appRolesSchema.default(['api']),
  DATABASE_URL: postgresUrl,
  MIGRATION_DATABASE_URL: postgresUrl.optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ENDPOINT_URL: z.url().optional(),
  SQS_WAGER_TRANSACTIONS_QUEUE: z.string().endsWith('.fifo').default('wager-transactions.fifo'),
  SQS_WAGER_TRANSACTIONS_DLQ: z.string().endsWith('.fifo').default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().endsWith('.fifo').default('wagering-events.fifo'),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(20_000),
});

export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly port: number;
  readonly logLevel: string;
  readonly roles: readonly AppRole[];
  readonly database: {
    readonly url: string;
    readonly migrationUrl: string | undefined;
    readonly poolMax: number;
  };
  readonly aws: {
    readonly region: string;
    readonly endpointUrl: string | undefined;
  };
  readonly sqs: {
    readonly wagerTransactionsQueue: string;
    readonly wagerTransactionsDlq: string;
    readonly eventsQueue: string;
  };
  readonly shutdownGraceMs: number;
}

export class InvalidConfigError extends Error {
  constructor(details: string) {
    super(`Invalid configuration:\n${details}`);
    this.name = 'InvalidConfigError';
  }
}

/** Parses and validates the environment once, at boot. Fails fast on any invalid value. */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new InvalidConfigError(z.prettifyError(parsed.error));
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    roles: e.APP_ROLES,
    database: {
      url: e.DATABASE_URL,
      migrationUrl: e.MIGRATION_DATABASE_URL,
      poolMax: e.DATABASE_POOL_MAX,
    },
    aws: { region: e.AWS_REGION, endpointUrl: e.AWS_ENDPOINT_URL },
    sqs: {
      wagerTransactionsQueue: e.SQS_WAGER_TRANSACTIONS_QUEUE,
      wagerTransactionsDlq: e.SQS_WAGER_TRANSACTIONS_DLQ,
      eventsQueue: e.SQS_EVENTS_QUEUE,
    },
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
  };
}
