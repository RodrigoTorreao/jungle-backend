import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import type { FaultInjector } from '../../src/application/ports/fault-injector';
import type { UnitOfWork } from '../../src/application/ports/persistence';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet';
import { createApp } from '../../src/bootstrap';
import { Money } from '../../src/domain/money/money';
import { applyWagerPolicy, type WagerOutcome } from '../../src/domain/wagering/wager-policy';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import type { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { createOrmOptions } from '../../src/infrastructure/persistence/mikro-orm.config';
import {
  MikroOrmUnitOfWork,
  type UnitOfWorkOptions,
} from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { MikroOrmWalletReader } from '../../src/infrastructure/persistence/repositories';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system/system-adapters';
import type { TestDatabase } from './database';
import { baseAppEnv } from './test-env';

export const ids = new UuidV7Generator();
export const clock = new SystemClock();

export interface Persistence {
  readonly orm: MikroORM;
  readonly unitOfWork: UnitOfWork;
  readonly reader: MikroOrmWalletReader;
  readonly createWallet: CreateWalletUseCase;
  close(): Promise<void>;
}

/** The real persistence stack, connected as the runtime role. */
export async function connectPersistence(
  db: TestDatabase,
  options: Partial<UnitOfWorkOptions> & { poolMax?: number; faults?: FaultInjector } = {},
): Promise<Persistence> {
  const orm = await MikroORM.init(
    createOrmOptions({ clientUrl: db.appUrl, poolMax: options.poolMax ?? 10 }),
  );
  const unitOfWork = new MikroOrmUnitOfWork(
    orm,
    clock,
    {
      lockTimeoutMs: options.lockTimeoutMs ?? 2_000,
      statementTimeoutMs: options.statementTimeoutMs ?? 5_000,
    },
    options.faults,
  );
  return {
    orm,
    unitOfWork,
    reader: new MikroOrmWalletReader(orm.em),
    createWallet: new CreateWalletUseCase(unitOfWork, ids, clock),
    close: () => orm.close(true),
  };
}

/**
 * Applies one provider operation through the real repositories (lock → policy → persist).
 * Sprint 3's ProcessWagerTransaction adds idempotency and references on top of this; tests use
 * it only to build realistic ledgers.
 */
export async function applyOperation(
  unitOfWork: UnitOfWork,
  walletId: string,
  kind: WagerTransactionKind,
  amount: string,
): Promise<{ transaction: WagerTransaction; outcome: WagerOutcome }> {
  return unitOfWork.run(async (scope) => {
    const wallet = await scope.wallets.lockForUpdate(walletId);
    if (wallet === undefined) {
      throw new Error(`wallet ${walletId} not found`);
    }
    const expectedVersion = wallet.version;
    const externalTransactionId = `ext-${ids.next()}`;
    const transaction = WagerTransaction.create({
      id: ids.next(),
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      payloadHash: 'a'.repeat(64),
      walletId,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      money: Money.from({ amount, currency: wallet.currency }),
      createdAt: clock.now(),
    });
    const outcome = applyWagerPolicy({
      transaction,
      wallet,
      reference: undefined,
      referenceAlreadyReversed: false,
      ledgerEntryId: ids.next(),
      now: clock.now(),
    });
    await scope.transactions.insert(transaction);
    if (outcome.status === 'PROCESSED' && outcome.ledgerEntry !== undefined) {
      await scope.ledger.append(outcome.ledgerEntry);
      await scope.wallets.update(wallet, expectedVersion);
    }
    return { transaction, outcome };
  });
}

export interface ApiHarness {
  readonly app: INestApplication;
  readonly baseUrl: string;
  close(): Promise<void>;
}

export async function startApi(
  db: TestDatabase,
  env: Record<string, string> = {},
): Promise<ApiHarness> {
  const app = await createApp(loadConfig(baseAppEnv({ DATABASE_URL: db.appUrl, ...env })));
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  return { app, baseUrl, close: () => app.close() };
}

/** Loosely typed JSON body: tests assert on arbitrary response shapes. */
// biome-ignore lint/suspicious/noExplicitAny: test-only, response bodies are asserted field by field
export type JsonBody = any;

export interface JsonResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: JsonBody;
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

export async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const response = await fetch(url, { headers });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
