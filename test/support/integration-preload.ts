/**
 * Preloaded once per `bun test` run of the integration/concurrency scripts: rebuilds the migrated
 * template from scratch (dropping leftovers of interrupted runs). Each test file clones it
 * (CREATE DATABASE … TEMPLATE), so files never share state and never pay the migration cost.
 * A plain `bun test` works too: `createTestDatabase()` builds the template on first use.
 *
 * Suites that use this preload must not run in parallel with each other (shared template).
 */
import { ensureTemplate } from './database';

await ensureTemplate({ reset: true });
