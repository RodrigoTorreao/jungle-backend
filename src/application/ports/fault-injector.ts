/**
 * Crash injection at exact points (CLAUDE.md: "crash em pontos exatos, nunca via timing").
 * Production wires a no-op. Tests choose a point and a mode:
 *  - `throw`: raises SimulatedCrashError, which no handler treats as a normal failure, leaving
 *    exactly the state a dead process leaves behind (committed rows, no ack, nothing marked);
 *  - `kill`: SIGKILLs the process (multi-process tests, Linux).
 */
export const FAULT_POINTS = [
  /** Inside the SQL transaction, right before COMMIT. */
  'before-commit',
  /** SQS consumer: the transaction committed, the message was not deleted yet. */
  'after-commit-before-ack',
  /** Outbox publisher: the broker accepted the batch, the rows are not marked yet. */
  'after-publish-before-mark',
] as const;

export type FaultPoint = (typeof FAULT_POINTS)[number];

export interface FaultInjector {
  hit(point: FaultPoint): void;
}

/** Thrown in `throw` mode. Adapters must not ack, retry or mark anything when they see it. */
export class SimulatedCrashError extends Error {
  constructor(readonly point: FaultPoint) {
    super(`Simulated crash at ${point}`);
    this.name = 'SimulatedCrashError';
  }
}

export const FAULT_INJECTOR = Symbol('FaultInjector');
