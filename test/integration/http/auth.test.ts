/**
 * S6-03 / D-04: AUTH_MODE=keycloak through the real HTTP stack. Tokens are signed here with a
 * key published on a local JWKS endpoint — the same validation path as Keycloak's tokens
 * (signature, iss, aud, exp), without the IdP in the loop. The real realm: docker/keycloak.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import { type ApiHarness, getJson, postJson, startApi } from '../../support/persistence';
import { submission } from '../../support/wagering';

const ISSUER = 'http://localhost:8180/realms/wagering';

let db: TestDatabase;
let api: ApiHarness;
let jwksServer: ReturnType<typeof Bun.serve>;
let sign: (claims: JWTPayload) => Promise<string>;

beforeAll(async () => {
  db = await createTestDatabase();
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  jwksServer = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  sign = (claims) =>
    new SignJWT({ iss: ISSUER, aud: 'wagering-api', sub: 'client', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  api = await startApi(db, {
    AUTH_MODE: 'keycloak',
    OIDC_ISSUER: ISSUER,
    OIDC_JWKS_URL: `${jwksServer.url}certs`,
  });
});

afterAll(async () => {
  await assertLedgerConsistency(db.ownerUrl);
  await api.close();
  jwksServer.stop(true);
  await db.drop();
});

const bearer = async (claims: JWTPayload) => ({ authorization: `Bearer ${await sign(claims)}` });
const providerA = () => bearer({ provider_id: 'provider-a' });
const backoffice = () => bearer({ sub: 'ops', realm_access: { roles: ['wallet-admin'] } });

async function openWallet(amount: string) {
  const response = await postJson(
    `${api.baseUrl}/wallets`,
    { playerId: Bun.randomUUIDv7(), initialBalance: { amount, currency: 'BRL' } },
    await backoffice(),
  );
  expect(response.status).toBe(201);
  return { id: response.body.id as string, playerId: response.body.playerId as string };
}

describe('AUTH_MODE=keycloak', () => {
  test('health and metrics stay open; everything else needs a token', async () => {
    expect((await getJson(`${api.baseUrl}/health/ready`)).status).toBe(200);
    expect((await fetch(`${api.baseUrl}/metrics`)).status).toBe(200);
    const anonymous = await postJson(`${api.baseUrl}/wallets`, {});
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe('UNAUTHENTICATED');
  });

  test('only the backoffice role opens wallets, reads the ledger and reconciles', async () => {
    const wallet = await openWallet('100.00');
    const asProvider = await providerA();

    const create = await postJson(
      `${api.baseUrl}/wallets`,
      { playerId: Bun.randomUUIDv7(), initialBalance: { amount: '1.00', currency: 'BRL' } },
      asProvider,
    );
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('FORBIDDEN');
    expect((await getJson(`${api.baseUrl}/wallets/${wallet.id}/ledger`, asProvider)).status).toBe(
      403,
    );
    expect(
      (await postJson(`${api.baseUrl}/wallets/${wallet.id}/reconciliation`, {}, asProvider)).status,
    ).toBe(403);

    // A provider may still read the balance it moves.
    expect((await getJson(`${api.baseUrl}/wallets/${wallet.id}`, asProvider)).status).toBe(200);
    const asOperator = await backoffice();
    expect((await getJson(`${api.baseUrl}/wallets/${wallet.id}/ledger`, asOperator)).status).toBe(
      200,
    );
    const reconciliation = await postJson(
      `${api.baseUrl}/wallets/${wallet.id}/reconciliation`,
      {},
      asOperator,
    );
    expect(reconciliation.body.consistent).toBe(true);
  });

  test('a provider acts only for itself: token provider_id must match the payload', async () => {
    const wallet = await openWallet('100.00');
    const asProvider = await providerA();
    const own = submission(wallet, 'BET', '10.00');
    const submit = (body: Record<string, unknown>) =>
      postJson(`${api.baseUrl}/wagering/transactions`, body, {
        ...asProvider,
        'idempotency-key': `${body.providerId}:${body.externalTransactionId}`,
      });

    expect((await submit(own)).status).toBe(200);
    const foreign = await submit(submission(wallet, 'BET', '10.00', { providerId: 'provider-b' }));
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('PROVIDER_MISMATCH');

    const asOtherProvider = await bearer({ provider_id: 'provider-b' });
    const read = (headers: Record<string, string>) =>
      getJson(
        `${api.baseUrl}/providers/provider-a/wagering/transactions/${own.externalTransactionId}`,
        headers,
      );
    expect((await read(asProvider)).status).toBe(200);
    expect((await read(asOtherProvider)).status).toBe(403);
    expect((await getJson(`${api.baseUrl}/wallets/${wallet.id}`, asProvider)).body.balance).toEqual(
      { amount: '90.00', currency: 'BRL' },
    );
  });
});
