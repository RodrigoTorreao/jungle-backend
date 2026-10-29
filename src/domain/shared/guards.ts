import { DomainValidationError } from './domain-error';

export function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainValidationError('VALIDATION_ERROR', `${field} must be a non-empty string`);
  }
}

/**
 * Integer check for counters (versions, attempts). Never used for money, which lives in
 * `Money` as bigint — hence the one sanctioned use of the `Number` global in the domain.
 */
export function isNonNegativeInteger(value: number): boolean {
  // biome-ignore lint/style/noRestrictedGlobals: integer counter check, not a monetary value
  return Number.isSafeInteger(value) && value >= 0;
}

export function addMilliseconds(at: Date, milliseconds: number): Date {
  return new Date(at.getTime() + milliseconds);
}
