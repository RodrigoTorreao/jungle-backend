import { ResourceNotFoundError } from '../errors';
import type { Principal } from '../ports/identity';
import type { WagerTransactionReader } from '../ports/persistence';
import { assertMayActFor, mayReadProvider } from '../services/authorization';
import { toWagerTransactionView, type WagerTransactionView } from '../views';

/**
 * Read access to transactions. A provider only ever sees its own: by internal id another
 * provider's transaction is simply "not found" (no enumeration); by provider path a foreign
 * provider id is refused outright.
 */
export class GetWagerTransactionQuery {
  constructor(private readonly reader: WagerTransactionReader) {}

  async byId(transactionId: string, principal: Principal): Promise<WagerTransactionView> {
    const transaction = await this.reader.findById(transactionId);
    if (transaction === undefined || !mayReadProvider(principal, transaction.providerId)) {
      throw new ResourceNotFoundError('Transaction', transactionId);
    }
    return toWagerTransactionView(transaction);
  }

  async byExternalId(
    providerId: string,
    externalTransactionId: string,
    principal: Principal,
  ): Promise<WagerTransactionView> {
    assertMayActFor(principal, providerId);
    const transaction = await this.reader.findByExternalId(providerId, externalTransactionId);
    if (transaction === undefined) {
      throw new ResourceNotFoundError('Transaction', `${providerId}/${externalTransactionId}`);
    }
    return toWagerTransactionView(transaction);
  }
}
