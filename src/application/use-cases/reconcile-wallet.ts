import { ResourceNotFoundError } from '../errors';
import type { AppLogger, Metrics } from '../ports/observability';
import type { ReconciliationReader } from '../ports/persistence';
import type { ReconciliationView } from '../views';

/**
 * Compares the materialized balance with the balance rebuilt from the ledger (RF-H07).
 * A divergence is never corrected here: it is logged, counted in a metric and reported with
 * `consistent: false` so an operator investigates. The schema makes divergence impossible
 * through the application; this check exists for what bypasses it (manual SQL, disabled
 * triggers, restored backups).
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly reader: ReconciliationReader,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
  ) {}

  async execute(walletId: string, correlationId: string): Promise<ReconciliationView> {
    const snapshot = await this.reader.snapshot(walletId);
    if (snapshot === undefined) {
      throw new ResourceNotFoundError('Wallet', walletId);
    }
    const consistent = snapshot.balancesMatch && snapshot.latestEntryMatches;
    if (!consistent) {
      this.metrics.reconciliationDivergence();
      // Amounts stay out of the log on purpose; the response carries them to the operator.
      this.logger.error(
        {
          walletId,
          correlationId,
          checkedEntries: snapshot.checkedEntries,
          balancesMatch: snapshot.balancesMatch,
          latestEntryMatches: snapshot.latestEntryMatches,
        },
        'Wallet balance diverges from its ledger',
      );
    }
    const money = (amount: string) => ({ amount, currency: snapshot.currency });
    return {
      walletId: snapshot.walletId,
      storedBalance: money(snapshot.storedBalance),
      calculatedBalance: money(snapshot.calculatedBalance),
      difference: money(snapshot.difference),
      consistent,
      checkedEntries: snapshot.checkedEntries,
    };
  }
}
