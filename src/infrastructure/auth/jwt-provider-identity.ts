import { createRemoteJWKSet, errors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { IdentityProviderUnavailableError, UnauthenticatedError } from '../../application/errors';
import type {
  Principal,
  ProviderIdentityPort,
  RequestCredentials,
} from '../../application/ports/identity';

export interface JwtIdentityOptions {
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly audience: string;
  /** Claim carrying the provider of a client-credentials token (Keycloak hardcoded mapper). */
  readonly providerClaim: string;
  /** Realm role of operators (wallet creation, ledger, reconciliation). */
  readonly backofficeRole: string;
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/** Failures fetching the key set: the IdP is down, not the caller's fault (503, retryable). */
const KEY_SET_FAILURES = [errors.JWKSTimeout, errors.JWKSInvalid];

/**
 * AUTH_MODE=keycloak (ARCHITECTURE §11): validates OIDC access tokens locally — signature
 * against the realm's JWKS (fetched once and cached by `jose`, refreshed on unknown `kid`),
 * plus `iss`, `aud` and `exp`. No call to the IdP per request, so Keycloak being down only
 * matters until the keys are cached.
 *
 * Mapping: the backoffice realm role wins; otherwise the provider claim names the provider.
 * A valid token with neither is still unauthenticated for this API.
 */
export class JwtProviderIdentity implements ProviderIdentityPort {
  private readonly keys: JWTVerifyGetKey;

  constructor(
    private readonly options: JwtIdentityOptions,
    keys?: JWTVerifyGetKey,
  ) {
    this.keys = keys ?? createRemoteJWKSet(new URL(options.jwksUrl), { timeoutDuration: 2_000 });
  }

  async resolve(credentials: RequestCredentials): Promise<Principal> {
    const token = BEARER.exec(credentials.authorization ?? '')?.[1];
    if (token === undefined) {
      throw new UnauthenticatedError('Missing bearer token');
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'sub'],
      }));
    } catch (error) {
      if (KEY_SET_FAILURES.some((type) => error instanceof type) || isFetchFailure(error)) {
        throw new IdentityProviderUnavailableError({ cause: error });
      }
      // Never echo token contents; the error class is enough to debug.
      throw new UnauthenticatedError(
        `Invalid token (${error instanceof Error ? error.name : 'unknown'})`,
      );
    }
    return this.principalOf(payload);
  }

  private principalOf(payload: JWTPayload): Principal {
    const realmAccess = payload.realm_access as { roles?: unknown } | undefined;
    const roles = Array.isArray(realmAccess?.roles) ? realmAccess.roles : [];
    if (roles.includes(this.options.backofficeRole)) {
      return { kind: 'backoffice', subject: String(payload.sub) };
    }
    const providerId = payload[this.options.providerClaim];
    if (typeof providerId === 'string' && providerId.length > 0) {
      return { kind: 'provider', providerId };
    }
    throw new UnauthenticatedError('Token carries no provider or backoffice identity');
  }
}

/** `fetch` of the JWKS failing at the network level (connection refused, DNS…). */
function isFetchFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && 'code' in error && error.code === 'ConnectionRefused')
  );
}
