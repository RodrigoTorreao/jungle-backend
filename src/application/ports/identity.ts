/**
 * Authentication extension point (Desafio §2, ARCHITECTURE §11).
 *
 * Who is calling a request. Use cases receive the principal and decide what it may do;
 * transports (HTTP guard, SQS consumer) only resolve it.
 *  - `trusted`: authentication is disabled (AUTH_MODE=disabled) or the channel is internal
 *    (the SQS queue). Domain validations of the providerId in the payload still apply.
 *  - `provider`: a game provider authenticated by the IdP (client credentials).
 *  - `backoffice`: an operator allowed to create wallets and run reconciliations.
 */
export type Principal =
  | { readonly kind: 'trusted' }
  | { readonly kind: 'provider'; readonly providerId: string }
  | { readonly kind: 'backoffice'; readonly subject: string };

/** Internal callers (SQS consumer, workers, scripts): no identity to check. */
export const TRUSTED: Principal = Object.freeze({ kind: 'trusted' });

export interface RequestCredentials {
  /** Raw `Authorization` header, when present. */
  readonly authorization: string | undefined;
}

export interface ProviderIdentityPort {
  /** @throws UnauthenticatedError when credentials are missing or invalid */
  resolve(credentials: RequestCredentials): Promise<Principal>;
}

export const PROVIDER_IDENTITY = Symbol('ProviderIdentityPort');
