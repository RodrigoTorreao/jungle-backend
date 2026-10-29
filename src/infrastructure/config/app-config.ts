import { z } from 'zod';
import { FAULT_POINTS, type FaultPoint } from '../../application/ports/fault-injector';

export const APP_ROLES = [
  'api',
  'consumer',
  'outbox-publisher',
  'pending-reference-worker',
  'reconciliation-worker',
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

const faultPointsSchema = z
  .string()
  .transform((raw) =>
    raw
      .split(',')
      .map((point) => point.trim())
      .filter((point) => point.length > 0),
  )
  .pipe(z.array(z.enum(FAULT_POINTS)));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_ROLES: appRolesSchema.default(['api']),
  DATABASE_URL: postgresUrl,
  MIGRATION_DATABASE_URL: postgresUrl.optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ENDPOINT_URL: z.url().optional(),
  SQS_WAGER_TRANSACTIONS_QUEUE: z.string().endsWith('.fifo').default('wager-transactions.fifo'),
  SQS_WAGER_TRANSACTIONS_DLQ: z.string().endsWith('.fifo').default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().endsWith('.fifo').default('wagering-events.fifo'),
  /** Inbox consumer name: dedup scope of (consumerName, messageId). */
  SQS_CONSUMER_NAME: z.string().min(1).max(128).default('wager-transactions'),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_MAX_MESSAGES: z.coerce.number().int().min(1).max(10).default(10),
  /** Visibility backoff of transient failures: base * 2^(receiveCount-1), capped. */
  SQS_RETRY_BASE_SECONDS: z.coerce.number().int().min(0).default(2),
  SQS_RETRY_MAX_SECONDS: z.coerce.number().int().min(0).max(43_200).default(60),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  PENDING_REFERENCE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  PENDING_REFERENCE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  RECONCILIATION_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  RECONCILIATION_SAMPLE_SIZE: z.coerce.number().int().min(1).max(1_000).default(25),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(20_000),
  /** `disabled`: every caller is trusted. `keycloak`: OIDC access tokens (ARCHITECTURE §11). */
  AUTH_MODE: z.enum(['disabled', 'keycloak']).default('disabled'),
  /** Expected `iss` (the realm URL as clients see it). */
  OIDC_ISSUER: z.url().optional(),
  /** Where the signing keys are fetched; defaults to the issuer's certs endpoint. */
  OIDC_JWKS_URL: z.url().optional(),
  OIDC_AUDIENCE: z.string().min(1).default('wagering-api'),
  OIDC_PROVIDER_CLAIM: z.string().min(1).default('provider_id'),
  OIDC_BACKOFFICE_ROLE: z.string().min(1).default('wallet-admin'),
  /** Test-only crash injection (refused in production). */
  FAULT_POINTS: faultPointsSchema.default([]),
  FAULT_MODE: z.enum(['throw', 'kill']).default('throw'),
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
    readonly lockTimeoutMs: number;
    readonly statementTimeoutMs: number;
  };
  readonly aws: {
    readonly region: string;
    readonly endpointUrl: string | undefined;
  };
  readonly sqs: {
    readonly wagerTransactionsQueue: string;
    readonly wagerTransactionsDlq: string;
    readonly eventsQueue: string;
    readonly consumerName: string;
    readonly waitTimeSeconds: number;
    readonly maxMessages: number;
    readonly retryBaseSeconds: number;
    readonly retryMaxSeconds: number;
  };
  readonly outbox: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
  };
  readonly pendingReferences: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
  };
  readonly reconciliation: {
    readonly intervalMs: number;
    readonly sampleSize: number;
  };
  readonly shutdownGraceMs: number;
  readonly auth:
    | { readonly mode: 'disabled' }
    | {
        readonly mode: 'keycloak';
        readonly issuer: string;
        readonly jwksUrl: string;
        readonly audience: string;
        readonly providerClaim: string;
        readonly backofficeRole: string;
      };
  readonly faults: {
    readonly points: readonly FaultPoint[];
    readonly mode: 'throw' | 'kill';
  };
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
  if (e.NODE_ENV === 'production' && e.FAULT_POINTS.length > 0) {
    throw new InvalidConfigError('FAULT_POINTS cannot be armed in production');
  }
  if (e.AUTH_MODE === 'keycloak' && e.OIDC_ISSUER === undefined) {
    throw new InvalidConfigError('AUTH_MODE=keycloak requires OIDC_ISSUER');
  }
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    roles: e.APP_ROLES,
    database: {
      url: e.DATABASE_URL,
      migrationUrl: e.MIGRATION_DATABASE_URL,
      poolMax: e.DATABASE_POOL_MAX,
      lockTimeoutMs: e.DATABASE_LOCK_TIMEOUT_MS,
      statementTimeoutMs: e.DATABASE_STATEMENT_TIMEOUT_MS,
    },
    aws: { region: e.AWS_REGION, endpointUrl: e.AWS_ENDPOINT_URL },
    sqs: {
      wagerTransactionsQueue: e.SQS_WAGER_TRANSACTIONS_QUEUE,
      wagerTransactionsDlq: e.SQS_WAGER_TRANSACTIONS_DLQ,
      eventsQueue: e.SQS_EVENTS_QUEUE,
      consumerName: e.SQS_CONSUMER_NAME,
      waitTimeSeconds: e.SQS_WAIT_TIME_SECONDS,
      maxMessages: e.SQS_MAX_MESSAGES,
      retryBaseSeconds: e.SQS_RETRY_BASE_SECONDS,
      retryMaxSeconds: e.SQS_RETRY_MAX_SECONDS,
    },
    outbox: { pollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS, batchSize: e.OUTBOX_BATCH_SIZE },
    pendingReferences: {
      pollIntervalMs: e.PENDING_REFERENCE_POLL_INTERVAL_MS,
      batchSize: e.PENDING_REFERENCE_BATCH_SIZE,
    },
    reconciliation: {
      intervalMs: e.RECONCILIATION_INTERVAL_MS,
      sampleSize: e.RECONCILIATION_SAMPLE_SIZE,
    },
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    auth:
      e.AUTH_MODE === 'keycloak' && e.OIDC_ISSUER !== undefined
        ? {
            mode: 'keycloak',
            issuer: e.OIDC_ISSUER,
            jwksUrl: e.OIDC_JWKS_URL ?? `${e.OIDC_ISSUER}/protocol/openid-connect/certs`,
            audience: e.OIDC_AUDIENCE,
            providerClaim: e.OIDC_PROVIDER_CLAIM,
            backofficeRole: e.OIDC_BACKOFFICE_ROLE,
          }
        : { mode: 'disabled' },
    faults: { points: e.FAULT_POINTS, mode: e.FAULT_MODE },
  };
}
