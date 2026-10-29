/**
 * Connection settings for the test harness. Values come from `.env` (auto-loaded by Bun)
 * or from CI, falling back to the docker-compose defaults.
 */
const DEFAULT_ADMIN_URL = 'postgres://postgres:postgres@localhost:5432/postgres';
const DEFAULT_OWNER_URL = 'postgres://wallet_owner:wallet_owner@localhost:5432/wagering';
const DEFAULT_APP_URL = 'postgres://wallet_app:wallet_app@localhost:5432/wagering';

export const TEMPLATE_DATABASE = 'wagering_test_template';
export const TEST_DATABASE_PREFIX = 'wagering_t_';

export const testEnv = {
  adminUrl: process.env.TEST_ADMIN_DATABASE_URL ?? DEFAULT_ADMIN_URL,
  ownerUrl: process.env.MIGRATION_DATABASE_URL ?? DEFAULT_OWNER_URL,
  appUrl: process.env.DATABASE_URL ?? DEFAULT_APP_URL,
} as const;

/** Same credentials and host, different database. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Base environment for booting the app in tests; callers override what they need. */
export function baseAppEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PORT: '0',
    APP_ROLES: 'api',
    DATABASE_URL: testEnv.appUrl,
    DATABASE_POOL_MAX: '5',
    // The SDK would read it from process.env anyway; through the config it also pins requests
    // to the endpoint instead of the QueueUrl host (ADR-015).
    ...(process.env.AWS_ENDPOINT_URL ? { AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL } : {}),
    ...overrides,
  };
}
