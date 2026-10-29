import type { AppLogger } from '../../application/ports/observability';

/**
 * Runs `tick` in a loop: immediately again while it reports work, otherwise after
 * `intervalMs`. `stop()` wakes it up and waits for the current tick to finish.
 */
export class PollingWorker {
  private running: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<number>,
    private readonly intervalMs: number,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running !== undefined) {
      return;
    }
    this.stopping = false;
    this.running = this.loop().finally(() => {
      this.running = undefined;
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let work = 0;
      try {
        work = await this.tick();
      } catch (error) {
        this.logger.error({ worker: this.name, err: error }, 'Worker tick failed');
      }
      if (work === 0 && !this.stopping) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.intervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }
}
