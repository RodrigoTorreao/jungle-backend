import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type CryptoKey,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWTPayload,
  SignJWT,
} from 'jose';
import {
  IdentityProviderUnavailableError,
  UnauthenticatedError,
} from '../../../src/application/errors';
import {
  type JwtIdentityOptions,
  JwtProviderIdentity,
} from '../../../src/infrastructure/auth/jwt-provider-identity';

const options: JwtIdentityOptions = {
  issuer: 'http://localhost:8180/realms/wagering',
  jwksUrl: 'http://unused.invalid/certs',
  audience: 'wagering-api',
  providerClaim: 'provider_id',
  backofficeRole: 'wallet-admin',
};

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: JSONWebKeySet;
let jwksServer: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
  jwksServer = Bun.serve({ port: 0, fetch: () => Response.json(jwks) });
});

afterAll(() => jwksServer.stop(true));

async function token(
  claims: JWTPayload,
  { key = signingKey, expiresIn = '5m' }: { key?: CryptoKey; expiresIn?: string } = {},
) {
  return new SignJWT({ iss: options.issuer, aud: options.audience, sub: 'client-1', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

const identity = () => new JwtProviderIdentity(options, createLocalJWKSet(jwks));
const resolve = async (authorization: string | undefined) => identity().resolve({ authorization });

describe('JwtProviderIdentity', () => {
  test('a provider client-credentials token becomes a provider principal', async () => {
    const principal = await resolve(`Bearer ${await token({ provider_id: 'provider-a' })}`);
    expect(principal).toEqual({ kind: 'provider', providerId: 'provider-a' });
  });

  test('the backoffice realm role becomes a backoffice principal', async () => {
    const principal = await resolve(
      `Bearer ${await token({ sub: 'ops-1', realm_access: { roles: ['wallet-admin'] } })}`,
    );
    expect(principal).toEqual({ kind: 'backoffice', subject: 'ops-1' });
  });

  test.each([
    ['no header', async () => undefined],
    ['not a bearer token', async () => 'Basic dXNlcjpwYXNz'],
    [
      'wrong signature',
      async () => `Bearer ${await token({ provider_id: 'p' }, { key: otherKey })}`,
    ],
    ['expired', async () => `Bearer ${await token({ provider_id: 'p' }, { expiresIn: '-1m' })}`],
    ['another audience', async () => `Bearer ${await token({ provider_id: 'p', aud: 'other' })}`],
    [
      'another issuer',
      async () => `Bearer ${await token({ provider_id: 'p', iss: 'http://evil' })}`,
    ],
    ['no provider nor role', async () => `Bearer ${await token({ realm_access: { roles: [] } })}`],
  ])('%s → UNAUTHENTICATED', async (_case, header) => {
    await expect(resolve(await header())).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  test('an unsigned token (alg none) is refused', async () => {
    const [, payload] = (await token({ provider_id: 'p' })).split('.');
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    await expect(resolve(`Bearer ${header}.${payload}.x`)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  test('keys come from the remote JWKS endpoint', async () => {
    const remote = new JwtProviderIdentity({ ...options, jwksUrl: `${jwksServer.url}certs` });
    const authorization = `Bearer ${await token({ provider_id: 'provider-b' })}`;
    expect(await remote.resolve({ authorization })).toEqual({
      kind: 'provider',
      providerId: 'provider-b',
    });
  });

  test('an unreachable IdP is a retryable 503, not a 401', async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response() });
    const url = `${closed.url}certs`;
    closed.stop(true);
    const unreachable = new JwtProviderIdentity({ ...options, jwksUrl: url });
    const authorization = `Bearer ${await token({ provider_id: 'provider-a' })}`;
    await expect(unreachable.resolve({ authorization })).rejects.toBeInstanceOf(
      IdentityProviderUnavailableError,
    );
  });
});
