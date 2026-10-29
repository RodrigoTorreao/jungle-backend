import { Logger } from '@nestjs/common';
import type { AppLogger } from '../../application/ports/observability';

/** Routes use-case logs through Nest's logger, which nestjs-pino turns into JSON lines. */
export class NestAppLogger implements AppLogger {
  private readonly logger = new Logger('Application');

  info(context: Record<string, unknown>, message: string): void {
    this.logger.log(context, message);
  }

  warn(context: Record<string, unknown>, message: string): void {
    this.logger.warn(context, message);
  }

  error(context: Record<string, unknown>, message: string): void {
    this.logger.error(context, message);
  }
}
