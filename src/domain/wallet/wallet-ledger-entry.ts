import type { Money } from '../money/money';
import { InvariantViolationError } from '../shared/domain-error';
import { assertNonEmpty, isNonNegativeInteger } from '../shared/guards';
import { LedgerDirection } from './ledger-direction';

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  /** Wallet version after this movement: a gapless per-wallet sequence and the ledger cursor. */
  readonly walletVersion: number;
  readonly createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * One immutable line of the wallet ledger. No mutable fields, no transition methods:
 * immutability is structural, and the database refuses UPDATE/DELETE on top of that.
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly walletVersion: number,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Validates the arithmetic: balanceBefore ± money === balanceAfter, never negative. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    assertNonEmpty(props.id, 'ledger entry id');
    assertNonEmpty(props.walletId, 'walletId');
    assertNonEmpty(props.transactionId, 'transactionId');
    if (!props.money.isPositive()) {
      throw new InvariantViolationError('A ledger entry must move a positive amount');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvariantViolationError('A ledger entry cannot record a negative balance');
    }
    if (props.walletVersion < 1 || !isNonNegativeInteger(props.walletVersion)) {
      throw new InvariantViolationError('walletVersion must be a positive integer');
    }
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `Unbalanced ledger entry: ${props.balanceBefore} ${props.direction} ${props.money} != ${props.balanceAfter}`,
      );
    }
    return entry;
  }

  /** Rebuilds an already persisted entry. Does not re-validate. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      new Date(state.createdAt.getTime()),
    );
  }

  /** balanceBefore ± money === balanceAfter (throws on currency mismatch). */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
