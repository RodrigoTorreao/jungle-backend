/**
 * Preloaded once per `bun test` run of the integration/concurrency suites.
 * Builds a migrated template database; each test file clones it (CREATE DATABASE … TEMPLATE),
 * so files never share state and never pay the migration cost again.
 *
 * Suites that use this preload must not run in parallel with each other (shared template).
 */
import { migrateUp } from '../../src/infrastructure/persistence/migrator';
import { resetTemplateDatabase } from './database';

const templateUrl = await resetTemplateDatabase();
await migrateUp(templateUrl);
