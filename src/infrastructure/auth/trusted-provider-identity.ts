import type { Principal, ProviderIdentityPort } from '../../application/ports/identity';

/**
 * AUTH_MODE=disabled: every caller is trusted. For local development, tests and the load test;
 * AUTH_MODE=keycloak plugs JwtProviderIdentity into the same port.
 */
export class TrustedProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<Principal> {
    return { kind: 'trusted' };
  }
}
