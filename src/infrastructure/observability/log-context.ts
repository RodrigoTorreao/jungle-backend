import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Fields every log line of a unit of work carries (Desafio.md §12). Identifiers only — amounts
 * and balances never enter the context.
 */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  worker?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Per-request / per-message context, propagated through async calls with AsyncLocalStorage.
 * Adapters open a scope (HTTP middleware, SQS message, worker tick) and enrich it as they learn
 * more; the pino mixin stamps the current fields on every line, use-case logs included.
 */
export const logContext = {
  run<T>(initial: LogContext, work: () => T): T {
    return storage.run({ ...initial }, work);
  },

  assign(fields: LogContext): void {
    const current = storage.getStore();
    if (current !== undefined) {
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) {
          (current as Record<string, string>)[key] = value;
        }
      }
    }
  },

  current(): Readonly<LogContext> {
    return storage.getStore() ?? {};
  },
};
