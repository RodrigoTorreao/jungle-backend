import { ResourceNotFoundError } from '../errors';
import type { WalletReader } from '../ports/persistence';
import { decodeLedgerCursor, encodeLedgerCursor } from '../services/ledger-cursor';
import { type LedgerPageView, toLedgerEntryView, toWalletView, type WalletView } from '../views';

export class GetWalletQuery {
  constructor(private readonly reader: WalletReader) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.reader.findWallet(walletId);
    if (wallet === undefined) {
      throw new ResourceNotFoundError('Wallet', walletId);
    }
    return toWalletView(wallet);
  }
}

export interface ListWalletLedgerInput {
  readonly walletId: string;
  readonly cursor: string | undefined;
  readonly limit: number;
}

/** Newest-first keyset pagination over the immutable ledger. */
export class ListWalletLedgerQuery {
  constructor(private readonly reader: WalletReader) {}

  async execute(input: ListWalletLedgerInput): Promise<LedgerPageView> {
    const beforeVersion =
      input.cursor === undefined ? undefined : decodeLedgerCursor(input.walletId, input.cursor);
    const wallet = await this.reader.findWallet(input.walletId);
    if (wallet === undefined) {
      throw new ResourceNotFoundError('Wallet', input.walletId);
    }
    const page = await this.reader.listLedger(input.walletId, {
      beforeVersion,
      limit: input.limit,
    });
    const last = page.entries.at(-1);
    return {
      items: page.entries.map(toLedgerEntryView),
      nextCursor:
        page.hasMore && last !== undefined
          ? encodeLedgerCursor(input.walletId, last.walletVersion)
          : null,
    };
  }
}
