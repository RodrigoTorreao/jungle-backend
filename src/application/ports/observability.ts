/**
 * Observability ports used by use cases. Adapters live in infrastructure (pino, prom-client);
 * the use cases only state what happened. Log context must never carry amounts or balances.
 */
export interface AppLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface Metrics {
  /** A reconciliation found the stored balance diverging from the ledger. */
  reconciliationDivergence(): void;
}

export const APP_LOGGER = Symbol('AppLogger');
export const METRICS = Symbol('Metrics');
