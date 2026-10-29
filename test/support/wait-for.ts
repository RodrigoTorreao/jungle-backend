export interface WaitForOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly description?: string;
}

/**
 * Polls `probe` until it returns a truthy value or the timeout expires.
 * Use this instead of fixed sleeps: tests wait for a condition, not for time.
 */
export async function waitFor<T>(
  probe: () => T | Promise<T>,
  { timeoutMs = 10_000, intervalMs = 50, description = 'condition' }: WaitForOptions = {},
): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  while (performance.now() < deadline) {
    try {
      const value = await probe();
      if (value) {
        return value as NonNullable<T>;
      }
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(intervalMs);
  }
  const cause = lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}${cause}`);
}

/** A promise you resolve from the outside: used as a barrier between concurrent actors. */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
