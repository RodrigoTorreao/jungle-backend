import { TRUSTED } from '../ports/identity';
import type { ReconciliationReader } from '../ports/persistence';
import type { Clock } from '../ports/system';
import type { ReconcileWalletUseCase } from './reconcile-wallet';

export interface SampledReconciliationPolicy {
  readonly sampleSize: number;
  /** Wallets changed within this window are checked before the random fill. */
  readonly recentWindowMs: number;
}

export interface SampledReconciliationReport {
  readonly checked: number;
  readonly divergentWalletIds: readonly string[];
}

/**
 * Periodic reconciliation by sampling (D-07): each run checks a few wallets with the same
 * read-only comparison as POST /wallets/:id/reconciliation. Recently changed wallets come first
 * (where a bypass would most likely show up), the rest at random so idle wallets are covered
 * over time. Nothing is locked or corrected, so several instances running it at once only
 * overlap work; divergences go to the log and to `wallet_reconciliation_divergences_total`.
 */
export class ReconcileSampleUseCase {
  constructor(
    private readonly reader: ReconciliationReader,
    private readonly reconcile: ReconcileWalletUseCase,
    private readonly clock: Clock,
    private readonly policy: SampledReconciliationPolicy,
  ) {}

  async runOnce(correlationId: string): Promise<SampledReconciliationReport> {
    const recentSince = new Date(this.clock.now().getTime() - this.policy.recentWindowMs);
    const walletIds = await this.reader.sampleWalletIds(this.policy.sampleSize, recentSince);
    const divergentWalletIds: string[] = [];
    for (const walletId of walletIds) {
      // Wallets are never deleted, so a sampled id always reconciles.
      const view = await this.reconcile.execute(walletId, correlationId, TRUSTED, 'sampled');
      if (!view.consistent) {
        divergentWalletIds.push(walletId);
      }
    }
    return { checked: walletIds.length, divergentWalletIds };
  }
}
