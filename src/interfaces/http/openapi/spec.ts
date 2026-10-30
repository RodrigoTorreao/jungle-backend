import { z } from 'zod';
import { WagerSubmissionBody } from '../../contracts/wager-submission';
import { IdempotencyKeyHeader } from '../wagering/wagering.controller';
import { CreateWalletBody, LedgerQueryParams } from '../wallets/wallets.controller';
import {
  LedgerEntryResponse,
  LedgerPageResponse,
  LiveResponse,
  MoneyResponse,
  ProblemResponse,
  ReadinessResponse,
  ReconciliationResponse,
  WagerResponse,
  WagerTransactionResponse,
  WalletResponse,
} from './schemas';

/**
 * OpenAPI 3.1 document of the HTTP API (GET /openapi.json, rendered at GET /docs). Built from
 * the same zod schemas that validate requests (`WagerSubmissionBody`, `CreateWalletBody`, …)
 * and the response schemas of `schemas.ts`; `test/integration/http/openapi.test.ts` checks that
 * every route is documented and that real responses match. Status mapping: ARCHITECTURE §9.
 */

type JsonSchema = Record<string, unknown>;

/** JSON Schema of a request input, without the `$schema` header (embedded in the document). */
function input(schema: z.ZodType): JsonSchema {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as JsonSchema;
  return rest;
}

const ref = (schema: z.ZodType) => ({ $ref: `#/components/schemas/${schema.meta()?.id}` });

function components(): JsonSchema {
  const registered = [
    MoneyResponse,
    LedgerEntryResponse,
    WalletResponse,
    LedgerPageResponse,
    WagerResponse,
    WagerTransactionResponse,
    ReconciliationResponse,
    ProblemResponse,
    LiveResponse,
    ReadinessResponse,
  ];
  const registry = z.registry<{ id: string }>();
  for (const schema of registered) {
    const id = schema.meta()?.id;
    if (id !== undefined) registry.add(schema, { id });
  }
  const { schemas } = z.toJSONSchema(registry, {
    uri: (id) => `#/components/schemas/${id}`,
  }) as { schemas: Record<string, JsonSchema> };
  return Object.fromEntries(
    Object.entries(schemas).map(([id, { $schema: _, $id: __, ...schema }]) => [id, schema]),
  );
}

const json = (schema: unknown, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const problem = (description: string, codes: readonly string[]) => ({
  description: `${description}. \`code\`: ${codes.map((c) => `\`${c}\``).join(', ')}`,
  content: { 'application/problem+json': { schema: ref(ProblemResponse) } },
});

const RETRY_AFTER = {
  'Retry-After': { description: 'Seconds to wait before resending', schema: { type: 'string' } },
};
const transient = {
  ...problem('Transient failure: resend the same request unchanged', [
    'DATABASE_UNAVAILABLE',
    'LOCK_TIMEOUT',
    'CONCURRENCY_CONFLICT',
    'BROKER_UNAVAILABLE',
    'IDENTITY_PROVIDER_UNAVAILABLE',
  ]),
  headers: RETRY_AFTER,
};
const invalid = problem('Payload, header or path parameter invalid', [
  'VALIDATION_ERROR',
  'INVALID_MONEY',
  'UNSUPPORTED_KIND',
  'MISSING_REFERENCE',
]);
const unauthenticated = problem('Missing or invalid bearer token (AUTH_MODE=keycloak)', [
  'UNAUTHENTICATED',
]);
const backofficeOnly = problem('Requires the `wallet-admin` role (backoffice)', ['FORBIDDEN']);
const notFound = problem('Unknown resource', ['NOT_FOUND']);

const walletIdParam = {
  name: 'walletId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const PUBLIC = { security: [] };

export function buildOpenApiDocument(): JsonSchema {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Jungle Wagering — Distributed Wagering Processor',
      version: '1.0.0',
      description: [
        'Financial wagering API: BET, WIN, LOSS, REFUND and ROLLBACK from game providers, correct',
        'under duplication, reordering, concurrency and multiple instances.',
        '',
        '- Every submission needs an `Idempotency-Key`; a resend returns the original outcome',
        '  with `idempotentReplay: true`, a different payload under the same key is `409`.',
        '- Money is always a decimal string with exactly 2 places (`"25.00"`), never a number.',
        '- Each situation has its own status: 400 invalid · 401/403 identity · 409 conflict ·',
        '  422 business rejection · 202 pending reference · 503 transient (`Retry-After`).',
        '- With `AUTH_MODE=keycloak`, use OAuth2 client credentials (provider-a / provider-b /',
        '  backoffice, secret `<client>-secret` in the development realm).',
      ].join('\n'),
    },
    servers: [{ url: '/' }],
    security: [{ keycloak: [] }],
    tags: [
      { name: 'Wagering', description: 'Provider operations and transaction lookups' },
      { name: 'Wallets', description: 'Balances, ledger and reconciliation (backoffice)' },
      {
        name: 'Operations',
        description: 'Health, metrics and this document — never authenticated',
      },
    ],
    paths: {
      '/wagering/transactions': {
        post: {
          tags: ['Wagering'],
          summary: 'Submit a wager operation',
          description:
            'Same use case as the SQS consumer. The authenticated provider must match `providerId` ' +
            '(`403 PROVIDER_MISMATCH`). REFUND/ROLLBACK whose reference has not arrived yet are ' +
            'parked as PENDING_REFERENCE (`202`) and resolved by a worker.',
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              description: 'Recommended: `{providerId}:{externalTransactionId}`',
              schema: input(IdempotencyKeyHeader),
            },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: input(WagerSubmissionBody) } },
          },
          responses: {
            '200': json(ref(WagerResponse), 'Processed (new or replay)'),
            '202': json(ref(WagerResponse), 'Accepted, waiting for the referenced transaction'),
            '400': invalid,
            '401': unauthenticated,
            '403': problem('The token’s provider is not the payload’s', ['PROVIDER_MISMATCH']),
            '409': problem('Same key or external id with a different payload: do not resend', [
              'IDEMPOTENCY_KEY_CONFLICT',
              'EXTERNAL_TRANSACTION_ID_CONFLICT',
            ]),
            '422': {
              description:
                'Business rejection, persisted (`WagerOutcome` with `status: REJECTED` and a ' +
                '`failureCode`), or `WALLET_NOT_FOUND` as problem details (nothing persisted)',
              content: {
                'application/json': { schema: ref(WagerResponse) },
                'application/problem+json': { schema: ref(ProblemResponse) },
              },
            },
            '500': {
              description: 'Permanently FAILED transaction (replay) or unexpected error',
              content: {
                'application/json': { schema: ref(WagerResponse) },
                'application/problem+json': { schema: ref(ProblemResponse) },
              },
            },
            '503': transient,
          },
        },
      },
      '/wagering/transactions/{transactionId}': {
        get: {
          tags: ['Wagering'],
          summary: 'Transaction by internal id',
          description: 'Another provider’s transaction is reported as `404` (no enumeration).',
          parameters: [
            {
              name: 'transactionId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': json(ref(WagerTransactionResponse), 'The transaction'),
            '400': invalid,
            '401': unauthenticated,
            '404': notFound,
          },
        },
      },
      '/providers/{providerId}/wagering/transactions/{externalTransactionId}': {
        get: {
          tags: ['Wagering'],
          summary: 'Transaction by the provider’s own id',
          parameters: [
            { name: 'providerId', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'externalTransactionId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': json(ref(WagerTransactionResponse), 'The transaction'),
            '400': invalid,
            '401': unauthenticated,
            '403': problem('Another provider’s path', ['PROVIDER_MISMATCH']),
            '404': notFound,
          },
        },
      },
      '/wallets': {
        post: {
          tags: ['Wallets'],
          summary: 'Open a wallet (backoffice)',
          description:
            'A positive initial balance becomes an OPENING transaction with its CREDIT entry, in ' +
            'the same SQL transaction as the wallet and its outbox events.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: input(CreateWalletBody) } },
          },
          responses: {
            '201': json(ref(WalletResponse), 'Opened'),
            '400': invalid,
            '401': unauthenticated,
            '403': backofficeOnly,
            '409': problem('The player already has a wallet in this currency', [
              'WALLET_ALREADY_EXISTS',
            ]),
            '503': transient,
          },
        },
      },
      '/wallets/{walletId}': {
        get: {
          tags: ['Wallets'],
          summary: 'Wallet and current balance',
          parameters: [walletIdParam],
          responses: {
            '200': json(ref(WalletResponse), 'The wallet'),
            '400': invalid,
            '401': unauthenticated,
            '404': notFound,
          },
        },
      },
      '/wallets/{walletId}/ledger': {
        get: {
          tags: ['Wallets'],
          summary: 'Immutable ledger, newest first (backoffice)',
          parameters: [
            walletIdParam,
            ...Object.entries(
              (input(LedgerQueryParams) as { properties: Record<string, JsonSchema> }).properties,
            ).map(([name, schema]) => ({ name, in: 'query', required: false, schema })),
          ],
          responses: {
            '200': json(ref(LedgerPageResponse), 'One page of entries'),
            '400': invalid,
            '401': unauthenticated,
            '403': backofficeOnly,
            '404': notFound,
          },
        },
      },
      '/wallets/{walletId}/reconciliation': {
        post: {
          tags: ['Wallets'],
          summary: 'Rebuild the balance from the ledger and compare (backoffice)',
          description:
            'Read-only snapshot; a divergence is reported, logged and counted, never corrected.',
          parameters: [walletIdParam],
          responses: {
            '200': json(ref(ReconciliationResponse), 'Comparison result'),
            '400': invalid,
            '401': unauthenticated,
            '403': backofficeOnly,
            '404': notFound,
          },
        },
      },
      '/health/live': {
        get: {
          tags: ['Operations'],
          summary: 'Liveness',
          ...PUBLIC,
          responses: { '200': json(ref(LiveResponse), 'The process is serving HTTP') },
        },
      },
      '/health/ready': {
        get: {
          tags: ['Operations'],
          summary: 'Readiness: PostgreSQL and every queue reachable, not shutting down',
          ...PUBLIC,
          responses: {
            '200': json(ref(ReadinessResponse), 'Ready'),
            '503': json(ref(ReadinessResponse), 'A dependency is down, or shutdown has started'),
          },
        },
      },
      '/metrics': {
        get: {
          tags: ['Operations'],
          summary: 'Prometheus metrics (catalogue: ARCHITECTURE §10)',
          ...PUBLIC,
          responses: {
            '200': {
              description: 'Prometheus text format',
              content: { 'text/plain': { schema: { type: 'string' } } },
            },
          },
        },
      },
      '/openapi.json': {
        get: {
          tags: ['Operations'],
          summary: 'This document',
          ...PUBLIC,
          responses: { '200': json({ type: 'object' }, 'OpenAPI 3.1 document') },
        },
      },
      '/docs': {
        get: {
          tags: ['Operations'],
          summary: 'Interactive documentation (Swagger UI)',
          ...PUBLIC,
          responses: {
            '200': {
              description: 'HTML page',
              content: { 'text/html': { schema: { type: 'string' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: components(),
      securitySchemes: {
        keycloak: {
          type: 'oauth2',
          description:
            'Only enforced with AUTH_MODE=keycloak. Providers: client credentials with the ' +
            '`provider_id` claim; backoffice: the `wallet-admin` realm role.',
          flows: {
            clientCredentials: {
              tokenUrl: 'http://localhost:8180/realms/wagering/protocol/openid-connect/token',
              scopes: {},
            },
          },
        },
      },
    },
  };
}
