import { Counter, Registry } from 'prom-client';
import type { Metrics } from '../../application/ports/observability';

/**
 * prom-client adapter. Each app instance owns its registry (no global default registry), so
 * tests and multiple apps in one process never share counters. Exposed at /metrics in Sprint 5.
 */
export class PromMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly reconciliationDivergences = new Counter({
    name: 'wallet_reconciliation_divergences_total',
    help: 'Reconciliations that found the stored balance diverging from the ledger',
    registers: [this.registry],
  });

  reconciliationDivergence(): void {
    this.reconciliationDivergences.inc();
  }
}
