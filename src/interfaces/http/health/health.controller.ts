import { Controller, Get } from '@nestjs/common';

/** Health endpoints are never authenticated (Desafio §2). Readiness arrives with S5-04. */
@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
