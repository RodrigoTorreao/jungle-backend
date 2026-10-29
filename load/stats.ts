/** Latency and outcome bookkeeping of one scenario (client side). */
export class Recorder {
  private readonly latenciesMs: number[] = [];
  readonly statuses = new Map<string, number>();
  replays = 0;
  /** performance.now() of the first and last measured instant. */
  startedAt = 0;
  endedAt = 0;

  record(status: number | 'network-error', latencyMs: number, code?: string): void {
    this.latenciesMs.push(latencyMs);
    const key = code === undefined ? String(status) : `${status} ${code}`;
    this.statuses.set(key, (this.statuses.get(key) ?? 0) + 1);
  }

  get requests(): number {
    return this.latenciesMs.length;
  }

  /** Requests whose answer is not a decided outcome (200/202/422): 5xx, 4xx, network errors. */
  get errors(): number {
    let errors = 0;
    for (const [key, count] of this.statuses) {
      if (!/^(200|202|422)\b/.test(key)) {
        errors += count;
      }
    }
    return errors;
  }

  summary(): ScenarioSummary {
    const seconds = (this.endedAt - this.startedAt) / 1_000;
    return {
      requests: this.requests,
      durationSeconds: round(seconds),
      throughputPerSecond: round(this.requests / seconds),
      latencyMs: percentiles(this.latenciesMs),
      errorRate: this.requests === 0 ? 0 : round(this.errors / this.requests, 5),
      replays: this.replays,
      statuses: Object.fromEntries([...this.statuses].sort()),
    };
  }
}

export interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface ScenarioSummary {
  readonly requests: number;
  readonly durationSeconds: number;
  readonly throughputPerSecond: number;
  readonly latencyMs: Percentiles;
  readonly errorRate: number;
  readonly replays: number;
  readonly statuses: Record<string, number>;
}

/** Nearest-rank percentiles. */
export function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => round(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0);
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted.at(-1) ?? 0) };
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
