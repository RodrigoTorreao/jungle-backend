import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import {
  ConcurrencyConflictError,
  InvariantBreachError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
} from '../../../src/application/errors';
import { WalletOpened } from '../../../src/domain/messaging/events';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { Money } from '../../../src/domain/money/money';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransaction } from '../../../src/domain/wagering/wager-transaction';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wagering/wager-transaction-kind';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { assertLedgerConsistency } from '../../support/ledger-consistency';
import {
  applyOperation,
  clock,
  connectPersistence,
  ids,
  type Persistence,
} from '../../support/persistence';
import { deferred } from '../../support/wait-for';

let db: TestDatabase;
let persistence: Persistence;

beforeAll(async () => {
  db = await createTestDatabase();
  persistence = await connectPersistence(db);
});

afterAll(async () => {
  await assertLedgerConsistency(db.ownerUrl);
  await persistence.close();
  await db.drop();
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const newWallet = (amount = '100.00') =>
  persistence.createWallet.execute({
    playerId: ids.next(),
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'test',
  });

describe('wallet repository', () => {
  test('a wallet round-trips through the database as an equal aggregate', async () => {
    const view = await newWallet('1000.00');
    const wallet = await persistence.reader.findWallet(view.id);
    expect(wallet?.balance.equals(brl('1000.00'))).toBe(true);
    expect(wallet?.version).toBe(1);
    expect(wallet?.playerId).toBe(view.playerId);
  });

  test('movements persist balance, version and a chained ledger', async () => {
    const view = await newWallet('100.00');
    await applyOperation(persistence.unitOfWork, view.id, Kind.Bet, '80.00');
    await applyOperation(persistence.unitOfWork, view.id, Kind.Win, '0.01');
    const { outcome } = await applyOperation(persistence.unitOfWork, view.id, Kind.Bet, '80.00');

    expect(outcome).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    const wallet = await persistence.reader.findWallet(view.id);
    expect(wallet?.balance.toJSON().amount).toBe('20.01');
    expect(wallet?.version).toBe(3);
    await assertLedgerConsistency(db.ownerUrl, [view.id]);
  });

  test('a duplicate (player, currency) surfaces as WalletAlreadyExistsError', async () => {
    const view = await newWallet('0.00');
    await expect(
      persistence.createWallet.execute({
        playerId: view.playerId,
        initialBalance: { amount: '5.00', currency: 'BRL' },
        correlationId: 'test',
      }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });

  test('a stale version is refused and nothing is persisted', async () => {
    const view = await newWallet('100.00');
    await expect(
      persistence.unitOfWork.run(async (scope) => {
        const wallet = await scope.wallets.lockForUpdate(view.id);
        if (!wallet) throw new Error('missing wallet');
        wallet.credit({
          ledgerEntryId: ids.next(),
          transactionId: ids.next(),
          money: brl('1.00'),
          at: clock.now(),
        });
        await scope.wallets.update(wallet, wallet.version - 2);
      }),
    ).rejects.toBeInstanceOf(ConcurrencyConflictError);
    expect((await persistence.reader.findWallet(view.id))?.version).toBe(1);
  });

  test('changing a balance without its ledger entry is refused at COMMIT', async () => {
    const view = await newWallet('100.00');
    await expect(
      persistence.unitOfWork.run(async (scope) => {
        const wallet = await scope.wallets.lockForUpdate(view.id);
        if (!wallet) throw new Error('missing wallet');
        const expected = wallet.version;
        wallet.debit({
          ledgerEntryId: ids.next(),
          transactionId: ids.next(),
          money: brl('10.00'),
          at: clock.now(),
        });
        await scope.wallets.update(wallet, expected); // entry deliberately not appended
      }),
    ).rejects.toBeInstanceOf(InvariantBreachError);
    expect((await persistence.reader.findWallet(view.id))?.balance.toJSON().amount).toBe('100.00');
  });

  test('a writer waiting on a locked wallet times out as a transient error', async () => {
    const view = await newWallet('100.00');
    const impatient = await connectPersistence(db, { lockTimeoutMs: 100 });
    const lockHeld = deferred();
    const release = deferred();
    const holder = persistence.unitOfWork.run(async (scope) => {
      await scope.wallets.lockForUpdate(view.id);
      lockHeld.resolve();
      await release.promise;
    });
    try {
      await lockHeld.promise;
      const error = await impatient.unitOfWork
        .run((scope) => scope.wallets.lockForUpdate(view.id))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TransientInfrastructureError);
      expect((error as TransientInfrastructureError).code).toBe(FailureCode.LockTimeout);
    } finally {
      release.resolve();
      await holder;
      await impatient.close();
    }
  });
});

describe('wager transaction repository', () => {
  test('round-trips every field, including a pending schedule', async () => {
    const view = await newWallet('100.00');
    const externalTransactionId = `refund-${ids.next()}`;
    const refund = WagerTransaction.create({
      id: ids.next(),
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      payloadHash: 'c'.repeat(64),
      walletId: view.id,
      playerId: view.playerId,
      roundId: 'round-9',
      gameId: 'game-9',
      kind: Kind.Refund,
      money: brl('10.00'),
      referenceExternalTransactionId: 'bet-not-yet',
      createdAt: clock.now(),
    });
    refund.markPendingReference(clock.now(), brl('100.00'));
    await persistence.unitOfWork.run((scope) => scope.transactions.insert(refund));

    const found = await persistence.unitOfWork.run((scope) =>
      scope.transactions.findByIdempotencyKey('provider-a', refund.idempotencyKey),
    );
    expect(found?.status).toBe(Status.PendingReference);
    expect(found?.referenceExternalTransactionId).toBe('bet-not-yet');
    expect(found?.money.equals(brl('10.00'))).toBe(true);
    expect(found?.nextAttemptAt?.getTime()).toBe(refund.nextAttemptAt?.getTime());
    expect(found?.resultBalance?.equals(brl('100.00'))).toBe(true);

    found?.reject(FailureCode.ReferenceNotFound, clock.now(), brl('100.00'));
    await persistence.unitOfWork.run(async (scope) => {
      if (found) await scope.transactions.update(found);
    });
    const rejected = await persistence.unitOfWork.run((scope) =>
      scope.transactions.findByExternalId('provider-a', externalTransactionId),
    );
    expect(rejected?.status).toBe(Status.Rejected);
    expect(rejected?.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(rejected?.nextAttemptAt).toBeUndefined();
  });

  test('the balance snapshot keeps its own currency (wallet currency, not operation currency)', async () => {
    const view = await newWallet('100.00');
    const externalTransactionId = `usd-bet-${ids.next()}`;
    const bet = WagerTransaction.create({
      id: ids.next(),
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      payloadHash: 'c'.repeat(64),
      walletId: view.id,
      playerId: view.playerId,
      roundId: 'round-9',
      gameId: 'game-9',
      kind: Kind.Bet,
      money: Money.from({ amount: '1.00', currency: 'USD' }),
      createdAt: clock.now(),
    });
    bet.reject(FailureCode.CurrencyMismatch, clock.now(), brl('100.00'));
    await persistence.unitOfWork.run((scope) => scope.transactions.insert(bet));

    const found = await persistence.unitOfWork.run((scope) => scope.transactions.findById(bet.id));
    expect(found?.money.currency).toBe('USD');
    expect(found?.resultBalance?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('hasProcessedReversal sees processed reversals only', async () => {
    const view = await newWallet('100.00');
    const { transaction: bet } = await applyOperation(
      persistence.unitOfWork,
      view.id,
      Kind.Bet,
      '10.00',
    );
    const check = () =>
      persistence.unitOfWork.run((scope) => scope.transactions.hasProcessedReversal(bet.id));
    expect(await check()).toBe(false);

    await persistence.unitOfWork.run(async (scope) => {
      const wallet = await scope.wallets.lockForUpdate(view.id);
      if (!wallet) throw new Error('missing wallet');
      const expected = wallet.version;
      const externalTransactionId = `refund-${ids.next()}`;
      const refund = WagerTransaction.create({
        id: ids.next(),
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        payloadHash: 'c'.repeat(64),
        walletId: view.id,
        playerId: view.playerId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: Kind.Refund,
        money: brl('10.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
        createdAt: clock.now(),
      });
      const entry = wallet.credit({
        ledgerEntryId: ids.next(),
        transactionId: refund.id,
        money: brl('10.00'),
        at: clock.now(),
      });
      refund.markProcessed(bet.id, clock.now(), wallet.balance);
      await scope.transactions.insert(refund);
      await scope.ledger.append(entry);
      await scope.wallets.update(wallet, expected);
    });
    expect(await check()).toBe(true);
  });
});

describe('inbox and outbox repositories', () => {
  test('tryReceive records a message once', async () => {
    const message = () =>
      InboxMessage.receive({
        messageId: `msg-${ids.next()}`,
        consumerName: 'wager-transactions',
        payloadHash: 'd'.repeat(64),
        receivedAt: clock.now(),
      });
    const first = message();
    const duplicate = InboxMessage.rehydrate({
      messageId: first.messageId,
      consumerName: first.consumerName,
      payloadHash: first.payloadHash,
      receivedAt: clock.now(),
    });
    expect(await persistence.unitOfWork.run((s) => s.inbox.tryReceive(first))).toBe(true);
    expect(await persistence.unitOfWork.run((s) => s.inbox.tryReceive(duplicate))).toBe(false);
    const found = await persistence.unitOfWork.run((s) =>
      s.inbox.find(first.consumerName, first.messageId),
    );
    expect(found?.payloadHash).toBe(first.payloadHash);
  });

  test('wallet creation enqueues WalletOpened and WalletBalanceChanged in the same commit', async () => {
    const view = await newWallet('42.00');
    const owner = new SQL(db.ownerUrl, { max: 1 });
    try {
      const rows: { event_type: string; payload: { data: Record<string, unknown> } }[] =
        await owner`SELECT event_type, payload FROM outbox_messages
                     WHERE aggregate_id = ${view.id} ORDER BY event_type`;
      expect(rows.map((row) => row.event_type)).toEqual(['WalletBalanceChanged', 'WalletOpened']);
      expect(rows[0]?.payload.data).toMatchObject({
        walletId: view.id,
        direction: 'CREDIT',
        balanceAfter: { amount: '42.00', currency: 'BRL' },
        walletVersion: 1,
      });
    } finally {
      await owner.close();
    }
  });

  test('enqueued messages keep the envelope verbatim', async () => {
    const view = await newWallet('0.00');
    const wallet = await persistence.reader.findWallet(view.id);
    if (!wallet) throw new Error('missing wallet');
    const event = WalletOpened.from(wallet, brl('0.00').toJSON(), {
      eventId: ids.next(),
      correlationId: 'corr-x',
      occurredAt: clock.now(),
    });
    await persistence.unitOfWork.run((scope) =>
      scope.outbox.enqueue([OutboxMessage.enqueue(event)]),
    );
    const owner = new SQL(db.ownerUrl, { max: 1 });
    try {
      const [row] = await owner`SELECT payload FROM outbox_messages WHERE id = ${event.eventId}`;
      expect(row.payload).toEqual(JSON.parse(JSON.stringify(event.toJSON())));
    } finally {
      await owner.close();
    }
  });
});
