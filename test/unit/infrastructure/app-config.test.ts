import { describe, expect, test } from 'bun:test';
import {
  APP_ROLES,
  InvalidConfigError,
  loadConfig,
} from '../../../src/infrastructure/config/app-config';

const minimal = { DATABASE_URL: 'postgres://app:app@localhost:5432/wagering' };

describe('loadConfig', () => {
  test('applies defaults on a minimal environment', () => {
    const config = loadConfig(minimal);

    expect(config.env).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.roles).toEqual(['api']);
    expect(config.database).toEqual({
      url: minimal.DATABASE_URL,
      migrationUrl: undefined,
      poolMax: 10,
      lockTimeoutMs: 2_000,
      statementTimeoutMs: 5_000,
    });
    expect(config.sqs.wagerTransactionsQueue).toBe('wager-transactions.fifo');
    expect(config.sqs.wagerTransactionsDlq).toBe('wager-transactions-dlq.fifo');
    expect(config.auth).toEqual({ mode: 'disabled' });
  });

  test('expands APP_ROLES=all into every role', () => {
    expect(loadConfig({ ...minimal, APP_ROLES: 'all' }).roles).toEqual([...APP_ROLES]);
  });

  test('parses a comma-separated role list', () => {
    const config = loadConfig({ ...minimal, APP_ROLES: ' api , consumer ' });
    expect(config.roles).toEqual(['api', 'consumer']);
  });

  test('AUTH_MODE=keycloak derives the JWKS endpoint from the issuer', () => {
    const issuer = 'http://localhost:8180/realms/wagering';
    expect(loadConfig({ ...minimal, AUTH_MODE: 'keycloak', OIDC_ISSUER: issuer }).auth).toEqual({
      mode: 'keycloak',
      issuer,
      jwksUrl: `${issuer}/protocol/openid-connect/certs`,
      audience: 'wagering-api',
      providerClaim: 'provider_id',
      backofficeRole: 'wallet-admin',
    });
  });

  test.each([
    ['missing DATABASE_URL', {}],
    ['non-postgres DATABASE_URL', { DATABASE_URL: 'mysql://localhost/db' }],
    ['unknown role', { ...minimal, APP_ROLES: 'api,cron' }],
    ['empty role list', { ...minimal, APP_ROLES: ' , ' }],
    ['non-numeric port', { ...minimal, PORT: 'eighty' }],
    ['an unknown fault point', { ...minimal, FAULT_POINTS: 'nowhere' }],
    [
      'fault points armed in production',
      { ...minimal, NODE_ENV: 'production', FAULT_POINTS: 'before-commit' },
    ],
    ['keycloak without an issuer', { ...minimal, AUTH_MODE: 'keycloak' }],
    ['an unknown auth mode', { ...minimal, AUTH_MODE: 'basic' }],
    ['non-FIFO input queue', { ...minimal, SQS_WAGER_TRANSACTIONS_QUEUE: 'wager-transactions' }],
  ])('rejects %s', (_case, env) => {
    expect(() => loadConfig(env)).toThrow(InvalidConfigError);
  });
});
