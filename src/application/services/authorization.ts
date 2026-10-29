import { ProviderMismatchError } from '../errors';
import type { Principal } from '../ports/identity';

/**
 * A provider may only act for itself. `trusted` callers (auth disabled, internal queue) are not
 * restricted here — the providerId they carry still goes through every domain validation.
 */
export function assertMayActFor(principal: Principal, providerId: string): void {
  if (principal.kind === 'trusted') {
    return;
  }
  if (principal.kind === 'provider' && principal.providerId === providerId) {
    return;
  }
  throw new ProviderMismatchError();
}

/** Whether the caller may read data of `providerId` (other providers' data stays invisible). */
export function mayReadProvider(principal: Principal, providerId: string): boolean {
  return principal.kind !== 'provider' || principal.providerId === providerId;
}
