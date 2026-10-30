import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PromMetrics } from '../../../infrastructure/observability/metrics';
import {
  ReadinessProbe,
  type ReadinessReport,
} from '../../../infrastructure/observability/readiness';
import { Public } from '../auth/auth.guard';

/** Operational endpoints. Never authenticated (Desafio.md §2). */
@Public()
@Controller()
export class HealthController {
  constructor(
    @Inject(ReadinessProbe) private readonly readiness: ReadinessProbe,
    @Inject(PromMetrics) private readonly metrics: PromMetrics,
  ) {}

  /** The process is alive and serving HTTP. */
  @Get('health/live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** PostgreSQL and SQS reachable, and not shutting down; 503 otherwise. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    response.status(report.status === 'ready' ? 200 : 503);
    return report;
  }

  /** Prometheus scrape endpoint (ARCHITECTURE §10). */
  @Get('metrics')
  async scrape(@Res() response: Response): Promise<void> {
    const body = await this.metrics.registry.metrics();
    response.type(this.metrics.registry.contentType).send(body);
  }
}
