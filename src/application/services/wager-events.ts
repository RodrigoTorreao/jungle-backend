import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/messaging/events';
import type { EventContext, IntegrationEvent } from '../../domain/messaging/integration-event';
import type { WagerOutcome } from '../../domain/wagering/wager-policy';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-kind';
import type { Wallet } from '../../domain/wallet/wallet';

/**
 * Integration events of one outcome (Desafio §11): processed (+ balance change when money
 * moved), rejected, or parked waiting for a reference. Shared by every path that decides an
 * outcome — submission over HTTP/SQS and the pending-reference worker.
 */
export function eventsForOutcome(
  transaction: WagerTransaction,
  wallet: Wallet,
  outcome: WagerOutcome,
  context: () => EventContext,
): IntegrationEvent<unknown>[] {
  switch (outcome.status) {
    case WagerTransactionStatus.Processed:
      return [
        WagerTransactionProcessed.from(transaction, context()),
        ...(outcome.ledgerEntry === undefined
          ? []
          : [WalletBalanceChanged.from(wallet, outcome.ledgerEntry, context())]),
      ];
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(transaction, context())];
    case WagerTransactionStatus.PendingReference:
      return [WagerTransactionPendingReference.from(transaction, context())];
  }
}
