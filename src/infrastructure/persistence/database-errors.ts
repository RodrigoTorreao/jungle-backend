import { ConnectionException } from '@mikro-orm/core';
import {
  ApplicationError,
  InvariantBreachError,
  TransientInfrastructureError,
} from '../../application/errors';
import { FailureCode } from '../../domain/wagering/failure-code';

/**
 * Classification by SQLSTATE, not by exception class: MikroORM 7 does not map every PostgreSQL
 * code (55P03 arrives as a plain DriverException — DECISION_LOG DL-005).
 */
const LOCK_TIMEOUT = '55P03';
const DEADLOCK = '40P01';
const SERIALIZATION_FAILURE = '40001';
const QUERY_CANCELED = '57014'; // statement_timeout
const UNIQUE_VIOLATION = '23505';
const TRANSIENT_CONNECTION_CLASSES = ['08', '53', '57P']; // connection, resources, shutdown

interface PgErrorFields {
  readonly code?: unknown;
  readonly sqlState?: unknown;
  readonly constraint?: unknown;
}

export function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { code, sqlState } = error as PgErrorFields;
  if (typeof sqlState === 'string') {
    return sqlState;
  }
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

export function constraintOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { constraint } = error as PgErrorFields;
  return typeof constraint === 'string' ? constraint : undefined;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  return (
    sqlStateOf(error) === UNIQUE_VIOLATION &&
    (constraint === undefined || constraintOf(error) === constraint)
  );
}

function isConnectionFailure(error: unknown): boolean {
  if (error instanceof ConnectionException) {
    return true;
  }
  const state = sqlStateOf(error);
  if (state !== undefined) {
    return TRANSIENT_CONNECTION_CLASSES.some((prefix) => state.startsWith(prefix));
  }
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' &&
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'].includes(code)
  );
}

/**
 * Translates driver errors that escaped a repository into application errors:
 * transient (retry unchanged) or invariant breach (a schema guarantee refused the write).
 * Application errors pass through untouched; anything else is rethrown as is.
 */
export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof ApplicationError) {
    return error;
  }
  const state = sqlStateOf(error);
  const message = error instanceof Error ? error.message : String(error);
  if (state === LOCK_TIMEOUT || state === QUERY_CANCELED) {
    return new TransientInfrastructureError(FailureCode.LockTimeout, message, { cause: error });
  }
  if (state === DEADLOCK || state === SERIALIZATION_FAILURE) {
    return new TransientInfrastructureError(FailureCode.ConcurrencyConflict, message, {
      cause: error,
    });
  }
  if (isConnectionFailure(error)) {
    return new TransientInfrastructureError(FailureCode.DatabaseUnavailable, message, {
      cause: error,
    });
  }
  if (state?.startsWith('23')) {
    return new InvariantBreachError(`Schema guarantee refused the write: ${message}`, {
      cause: error,
    });
  }
  return error;
}
