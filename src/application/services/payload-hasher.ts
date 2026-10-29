import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../../domain/money/money';
import { DomainValidationError } from '../../domain/shared/domain-error';
import { FailureCode } from '../../domain/wagering/failure-code';

/** Business fields of a wager submission — the only input to the payload hash. */
export interface WagerPayload {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
}

/**
 * Canonical JSON: object keys sorted recursively (by UTF-16 code unit), no whitespace, keys with
 * `undefined` omitted. Numbers are rejected on purpose — a financial payload carries amounts as
 * decimal strings, so a number here is a contract violation, not something to normalize.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`);
    return `{${entries.join(',')}}`;
  }
  throw new DomainValidationError(
    FailureCode.ValidationError,
    `canonicalJson does not accept values of type ${typeof value}`,
  );
}

/**
 * payloadHash = sha256_hex(canonicalJson(business subset)) — ARCHITECTURE §7.
 * The Idempotency-Key header, messageId, occurredAt and any other transport metadata are
 * excluded by construction: only the fields listed here are picked. `money` goes through
 * `Money.from`, so an invalid amount fails here instead of producing a hash.
 */
export function hashWagerPayload(payload: WagerPayload): string {
  const subset = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return sha256Hex(canonicalJson(subset));
}

/** Hash of the internal OPENING operation: identifies the wallet creation that produced it. */
export function hashOpeningPayload(walletId: string, playerId: string, initialBalance: MoneyProps) {
  return sha256Hex(
    canonicalJson({
      kind: 'OPENING',
      walletId,
      playerId,
      money: Money.from(initialBalance).toJSON(),
    }),
  );
}

/** Hash of a whole queue message payload (inbox): canonical JSON, so key order never matters. */
export function hashMessagePayload(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
