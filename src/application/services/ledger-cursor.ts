import { isNonNegativeInteger } from '../../domain/shared/guards';
import { InvalidRequestError } from '../errors';

/**
 * Opaque, stable keyset cursor for a wallet's ledger. It encodes the last walletVersion seen
 * (pages are newest first and exclusive), plus the wallet id so a cursor cannot be replayed
 * against another wallet. Ledger entries are immutable and versions monotonic, so a cursor
 * keeps pointing at the same position no matter how many entries are appended later.
 */
interface CursorPayload {
  readonly w: string;
  readonly v: number;
}

export function encodeLedgerCursor(walletId: string, walletVersion: number): string {
  const payload: CursorPayload = { w: walletId, v: walletVersion };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** @returns the exclusive upper bound (walletVersion) for the next page */
export function decodeLedgerCursor(walletId: string, cursor: string): number {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidRequestError('Malformed ledger cursor');
  }
  const { w, v } = (payload ?? {}) as Partial<CursorPayload>;
  if (w !== walletId) {
    throw new InvalidRequestError('Ledger cursor belongs to another wallet');
  }
  if (typeof v !== 'number' || !isNonNegativeInteger(v) || v < 1) {
    throw new InvalidRequestError('Malformed ledger cursor');
  }
  return v;
}
