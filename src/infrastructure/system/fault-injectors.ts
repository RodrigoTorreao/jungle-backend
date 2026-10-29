import {
  type FaultInjector,
  type FaultPoint,
  SimulatedCrashError,
} from '../../application/ports/fault-injector';

export class NoopFaultInjector implements FaultInjector {
  hit(): void {}
}

export type FaultMode = 'throw' | 'kill';

/**
 * Fires at the armed points. `times` bounds how often each point fires (default once), so a
 * test can crash the first attempt and let the redelivery succeed.
 */
export class ArmedFaultInjector implements FaultInjector {
  private readonly remaining = new Map<FaultPoint, number>();

  constructor(
    points: readonly FaultPoint[],
    private readonly mode: FaultMode = 'throw',
    times = 1,
  ) {
    for (const point of points) {
      this.remaining.set(point, times);
    }
  }

  hit(point: FaultPoint): void {
    const left = this.remaining.get(point) ?? 0;
    if (left <= 0) {
      return;
    }
    this.remaining.set(point, left - 1);
    if (this.mode === 'kill') {
      process.kill(process.pid, 'SIGKILL');
    }
    throw new SimulatedCrashError(point);
  }

  /** Whether an armed point has used up all its firings. */
  fired(point: FaultPoint): boolean {
    return this.remaining.get(point) === 0;
  }
}
