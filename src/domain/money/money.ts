import { DomainError } from '../shared/domain-error';

/** Wire/persistence shape. `amount` is always a decimal string with exactly two places. */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

const MINOR_UNITS_PER_UNIT = 100n;
/**
 * Contract format: no sign, no exponent, no whitespace, no leading zeros, exactly 2 decimals.
 * Rejecting instead of rounding is deliberate: there is no implicit rounding anywhere.
 */
const AMOUNT_PATTERN = /^(0|[1-9][0-9]*)\.[0-9]{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/** Largest value representable by the `numeric(20,2)` columns: 999999999999999999.99 */
const MAX_MINOR_UNITS = 10n ** 20n - 1n;

/**
 * Immutable monetary value with a fixed scale of 2, stored as a bigint of minor units.
 * Never goes through floating point (ADR-002). Every operation returns a new instance.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Parses the input contract. Accepts only non-negative amounts in the canonical format.
   * Negative values exist only as results of internal arithmetic (`negate`, `subtract`).
   */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props as { amount: unknown; currency: unknown };
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code (e.g. "BRL")');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `amount "${amount}" must be a non-negative decimal with exactly 2 places (e.g. "25.00")`,
      );
    }
    const [units = '0', cents = '00'] = amount.split('.');
    return Money.ofMinorUnits(BigInt(units) * MINOR_UNITS_PER_UNIT + BigInt(cents), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  private static ofMinorUnits(minorUnits: bigint, currency: string): Money {
    if (minorUnits > MAX_MINOR_UNITS || minorUnits < -MAX_MINOR_UNITS) {
      throw new InvalidMoneyError('amount exceeds the supported range (numeric(20,2))');
    }
    return new Money(minorUnits, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinorUnits(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinorUnits(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return Money.ofMinorUnits(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /** Value equality. Different currencies are simply not equal (no error). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    const negative = this.minorUnits < 0n;
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const units = absolute / MINOR_UNITS_PER_UNIT;
    const cents = (absolute % MINOR_UNITS_PER_UNIT).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${units}.${cents}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
