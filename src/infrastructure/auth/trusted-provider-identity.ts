import type { Principal, ProviderIdentityPort } from '../../application/ports/identity';

/**
 * AUTH_MODE=disabled: every caller is trusted. Used for local development and tests until the
 * IdP adapter (Keycloak, Sprint 6) plugs into the same port.
 */
export class TrustedProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<Principal> {
    return { kind: 'trusted' };
  }
}
