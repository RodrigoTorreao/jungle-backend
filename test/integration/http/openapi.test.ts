/**
 * S7-06: the OpenAPI document cannot drift from the code. Every route Nest serves is documented
 * (and nothing else), and real responses — produced by the real stack, not fixtures — validate
 * against the response schema the document declares for that status.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
  LedgerPageResponse,
  LiveResponse,
  ProblemResponse,
  ReadinessResponse,
  ReconciliationResponse,
  WagerResponse,
  WagerTransactionResponse,
  WalletResponse,
} from '../../../src/interfaces/http/openapi/schemas';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import {
  type ApiHarness,
  getJson,
  ids,
  type JsonResponse,
  postJson,
  startApi,
} from '../../support/persistence';
import { createWallet, submission, submit } from '../../support/wagering';

type Operation = { responses: Record<string, unknown> };
type OpenApiDocument = { paths: Record<string, Record<string, Operation>> };

let db: TestDatabase;
let api: ApiHarness;
let document: OpenApiDocument;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await startApi(db);
  document = (await getJson(`${api.baseUrl}/openapi.json`)).body;
});

afterAll(async () => {
  await assertLedgerConsistency(db.ownerUrl);
  await api.close();
  await db.drop();
});

/** The response is declared for (path, method, status) and matches the declared schema. */
function expectContract(
  path: string,
  method: 'get' | 'post',
  response: JsonResponse,
  status: number,
  schema: z.ZodType,
) {
  expect(response.status).toBe(status);
  expect(document.paths[path]?.[method]?.responses[String(status)]).toBeDefined();
  const result = schema.safeParse(response.body);
  if (!result.success) {
    throw new Error(`${method.toUpperCase()} ${path} ${status}: ${result.error.message}`);
  }
}

describe('OpenAPI document', () => {
  test('documents exactly the routes Nest serves', () => {
    // Express 5 router: one layer per route registered by the controllers.
    const router = api.app.getHttpAdapter().getInstance().router as {
      stack: { route?: { path: string; methods: Record<string, boolean> } }[];
    };
    const served = router.stack
      // Nest's own catch-all (`{/*splat}`, the 404 handler) is not an API route.
      .filter((layer) => layer.route !== undefined && !layer.route.path.includes('*'))
      .flatMap((layer) =>
        Object.keys(layer.route?.methods ?? {}).map(
          (method) => `${method} ${layer.route?.path.replace(/:(\w+)/g, '{$1}')}`,
        ),
      )
      .sort();
    const documented = Object.entries(document.paths)
      .flatMap(([path, operations]) => Object.keys(operations).map((method) => `${method} ${path}`))
      .sort();
    expect(served).toEqual(documented);
  });

  test('is served as JSON and rendered by a self-hosted Swagger UI', async () => {
    expect(document).toMatchObject({ openapi: '3.1.0' });
    const page = await fetch(`${api.baseUrl}/docs`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('SwaggerUIBundle');
    expect((await fetch(`${api.baseUrl}/docs/assets/swagger-ui-bundle.js`)).status).toBe(200);
  });
});

describe('real responses match the declared schemas', () => {
  test('operations and wallets', async () => {
    expectContract(
      '/health/live',
      'get',
      await getJson(`${api.baseUrl}/health/live`),
      200,
      LiveResponse,
    );
    expectContract(
      '/health/ready',
      'get',
      await getJson(`${api.baseUrl}/health/ready`),
      200,
      ReadinessResponse,
    );

    const playerId = ids.next();
    const body = { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } };
    const created = await postJson(`${api.baseUrl}/wallets`, body);
    expectContract('/wallets', 'post', created, 201, WalletResponse);
    expectContract(
      '/wallets',
      'post',
      await postJson(`${api.baseUrl}/wallets`, body),
      409,
      ProblemResponse,
    );
    expectContract(
      '/wallets',
      'post',
      await postJson(`${api.baseUrl}/wallets`, { playerId }),
      400,
      ProblemResponse,
    );

    const walletId = created.body.id as string;
    expectContract(
      '/wallets/{walletId}',
      'get',
      await getJson(`${api.baseUrl}/wallets/${walletId}`),
      200,
      WalletResponse,
    );
    expectContract(
      '/wallets/{walletId}',
      'get',
      await getJson(`${api.baseUrl}/wallets/${ids.next()}`),
      404,
      ProblemResponse,
    );
    expectContract(
      '/wallets/{walletId}/ledger',
      'get',
      await getJson(`${api.baseUrl}/wallets/${walletId}/ledger?limit=10`),
      200,
      LedgerPageResponse,
    );
    expectContract(
      '/wallets/{walletId}/reconciliation',
      'post',
      await postJson(`${api.baseUrl}/wallets/${walletId}/reconciliation`, {}),
      200,
      ReconciliationResponse,
    );
  });

  test('wager submissions: every persisted outcome and every error category', async () => {
    const wallet = await createWallet(api.baseUrl, '50.00');
    const path = '/wagering/transactions';
    const bet = submission(wallet, 'BET', '10.00');

    expectContract(path, 'post', await submit(api.baseUrl, bet), 200, WagerResponse);
    const replay = await submit(api.baseUrl, bet);
    expectContract(path, 'post', replay, 200, WagerResponse);
    expect(replay.body.idempotentReplay).toBe(true);
    expectContract(
      path,
      'post',
      await submit(api.baseUrl, { ...bet, money: { amount: '11.00', currency: 'BRL' } }),
      409,
      ProblemResponse,
    );
    expectContract(
      path,
      'post',
      await submit(api.baseUrl, submission(wallet, 'BET', '999.00')),
      422,
      WagerResponse,
    );
    expectContract(
      path,
      'post',
      await submit(
        api.baseUrl,
        submission({ id: ids.next(), playerId: ids.next() }, 'BET', '1.00'),
      ),
      422,
      ProblemResponse,
    );
    expectContract(
      path,
      'post',
      await submit(
        api.baseUrl,
        submission(wallet, 'REFUND', '5.00', {
          referenceExternalTransactionId: `late-${ids.next()}`,
        }),
      ),
      202,
      WagerResponse,
    );
    expectContract(
      path,
      'post',
      await submit(api.baseUrl, bet, { idempotencyKey: null }),
      400,
      ProblemResponse,
    );

    const processed = await submit(api.baseUrl, submission(wallet, 'WIN', '2.00'));
    expectContract(
      '/wagering/transactions/{transactionId}',
      'get',
      await getJson(`${api.baseUrl}/wagering/transactions/${processed.body.transactionId}`),
      200,
      WagerTransactionResponse,
    );
    expectContract(
      '/providers/{providerId}/wagering/transactions/{externalTransactionId}',
      'get',
      await getJson(
        `${api.baseUrl}/providers/${bet.providerId}/wagering/transactions/${bet.externalTransactionId}`,
      ),
      200,
      WagerTransactionResponse,
    );
  });
});
