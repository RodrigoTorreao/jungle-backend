import { CurrencyMismatchError, Money } from '../money/money';
import { DomainError, InvariantViolationError } from '../shared/domain-error';
import { assertNonEmpty, isNonNegativeInteger } from '../shared/guards';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(
    readonly walletId: string,
    readonly requested: Money,
    readonly available: Money,
  ) {
    super(`Wallet ${walletId}: cannot debit ${requested}, balance is ${available}`);
  }
}

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly at: Date;
  /** Ids for the internal OPENING transaction and its ledger entry (used when balance > 0). */
  readonly opening: { readonly transactionId: string; readonly ledgerEntryId: string };
}

export interface WalletOpening {
  readonly wallet: Wallet;
  /** CREDIT entry for the initial balance; undefined when the wallet opens at zero. */
  readonly openingEntry: WalletLedgerEntry | undefined;
}

export interface BalanceMovement {
  readonly ledgerEntryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at: Date;
}

const INITIAL_VERSION = 1;

/**
 * Aggregate root. The balance only changes through `debit`/`credit`, and each of them returns
 * the ledger entry describing the change — balance and ledger are produced together, so one
 * cannot move without the other.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a wallet at version 1. A positive initial balance is recorded as an OPENING credit
   * that is part of the creation itself, so it does not bump the version.
   */
  static open(props: OpenWalletProps): WalletOpening {
    assertNonEmpty(props.id, 'wallet id');
    assertNonEmpty(props.playerId, 'playerId');
    if (props.initialBalance.isNegative()) {
      throw new InvariantViolationError('A wallet cannot open with a negative balance');
    }
    const at = new Date(props.at.getTime());
    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      INITIAL_VERSION,
      at,
      at,
    );
    const openingEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.opening.ledgerEntryId,
          walletId: props.id,
          transactionId: props.opening.transactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(props.initialBalance.currency),
          balanceAfter: props.initialBalance,
          walletVersion: INITIAL_VERSION,
          createdAt: at,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  /** Rebuilds persisted state. Does not re-validate. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime()),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: BalanceMovement): WalletLedgerEntry {
    return this.move(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    return this.move(LedgerDirection.Credit, movement);
  }

  private move(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    if (!movement.money.isPositive()) {
      throw new InvariantViolationError('A balance movement must be a positive amount');
    }
    if (!isNonNegativeInteger(this._version)) {
      throw new InvariantViolationError(`Wallet ${this.id} has a corrupt version`);
    }
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? this._balance.add(movement.money)
        : this._balance.subtract(movement.money);
    if (balanceAfter.isNegative()) {
      throw new InsufficientFundsError(this.id, movement.money, this._balance);
    }

    const entry = WalletLedgerEntry.create({
      id: movement.ledgerEntryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: movement.at,
    });

    // State changes only after every check passed: a failed movement leaves the wallet intact.
    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = new Date(movement.at.getTime());
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
