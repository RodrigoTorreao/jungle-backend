import { SQL } from 'bun';
import { ids, type JsonResponse, postJson } from './persistence';

export const PROVIDER = 'provider-a';

export interface WalletRef {
  readonly id: string;
  readonly playerId: string;
}

export type Submission = Record<string, unknown> & {
  providerId: string;
  externalTransactionId: string;
};

/** A valid submission body for the wallet; override any field. */
export function submission(
  wallet: WalletRef,
  kind: string,
  amount: string,
  overrides: Record<string, unknown> = {},
): Submission {
  return {
    providerId: PROVIDER,
    externalTransactionId: `tx-${ids.next()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

/** POST /wagering/transactions with the recommended key `{providerId}:{externalTransactionId}`. */
export function submit(
  baseUrl: string,
  body: Submission,
  options: { idempotencyKey?: string | null; correlationId?: string } = {},
): Promise<JsonResponse> {
  const key =
    options.idempotencyKey === undefined
      ? `${body.providerId}:${body.externalTransactionId}`
      : options.idempotencyKey;
  return postJson(`${baseUrl}/wagering/transactions`, body, {
    ...(key === null ? {} : { 'idempotency-key': key }),
    ...(options.correlationId ? { 'x-correlation-id': options.correlationId } : {}),
  });
}

export async function createWallet(baseUrl: string, amount: string): Promise<WalletRef> {
  const response = await postJson(`${baseUrl}/wallets`, {
    playerId: ids.next(),
    initialBalance: { amount, currency: 'BRL' },
  });
  if (response.status !== 201) {
    throw new Error(`wallet creation failed: ${JSON.stringify(response.body)}`);
  }
  return { id: response.body.id, playerId: response.body.playerId };
}

export interface OutboxRow {
  aggregate_id: string;
  event_type: string;
  correlation_id: string;
  payload: { causationId?: string; data: Record<string, unknown> };
}

export async function outboxFor(
  databaseUrl: string,
  transactionIds: string[],
): Promise<OutboxRow[]> {
  const sql = new SQL(databaseUrl, { max: 1 });
  try {
    return await sql`
      SELECT aggregate_id, event_type, correlation_id, payload
        FROM outbox_messages
       WHERE aggregate_id IN ${sql(transactionIds)}
          OR payload->'data'->>'transactionId' IN ${sql(transactionIds)}
       ORDER BY event_type`;
  } finally {
    await sql.close();
  }
}

export async function countRows(databaseUrl: string, query: string, ...params: unknown[]) {
  const sql = new SQL(databaseUrl, { max: 1 });
  try {
    const [row] = await sql.unsafe(query, params as never[]);
    return Object.values(row as Record<string, number>)[0];
  } finally {
    await sql.close();
  }
}
