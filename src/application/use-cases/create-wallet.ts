import { WalletBalanceChanged, WalletOpened } from '../../domain/messaging/events';
import type { EventContext, IntegrationEvent } from '../../domain/messaging/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import type { Principal } from '../ports/identity';
import type { UnitOfWork } from '../ports/persistence';
import type { Clock, IdGenerator } from '../ports/system';
import { assertBackoffice } from '../services/authorization';
import { hashOpeningPayload } from '../services/payload-hasher';
import { toWalletView, type WalletView } from '../views';

export interface CreateWalletCommand {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
  readonly correlationId: string;
  readonly principal: Principal;
}

/**
 * Opens a wallet. A positive initial balance becomes an internal OPENING transaction with its
 * CREDIT ledger entry — all in the same SQL transaction as the wallet row and the outbox events.
 */
export class CreateWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    assertBackoffice(command.principal);
    const initialBalance = Money.from(command.initialBalance);
    const now = this.clock.now();
    const walletId = this.ids.next();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance,
      at: now,
      opening: { transactionId: this.ids.next(), ledgerEntryId: this.ids.next() },
    });

    const context = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      occurredAt: now,
    });
    const opening =
      openingEntry === undefined
        ? undefined
        : WagerTransaction.opening({
            id: openingEntry.transactionId,
            walletId,
            playerId: command.playerId,
            money: initialBalance,
            payloadHash: hashOpeningPayload(walletId, command.playerId, initialBalance.toJSON()),
            at: now,
          });
    const events: IntegrationEvent<unknown>[] = [
      WalletOpened.from(wallet, initialBalance.toJSON(), context()),
      ...(openingEntry === undefined
        ? []
        : [WalletBalanceChanged.from(wallet, openingEntry, context())]),
    ];

    await this.unitOfWork.run(async (scope) => {
      await scope.wallets.insert(wallet);
      if (opening !== undefined && openingEntry !== undefined) {
        await scope.transactions.insert(opening);
        await scope.ledger.append(openingEntry);
      }
      await scope.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));
    });

    return toWalletView(wallet);
  }
}
