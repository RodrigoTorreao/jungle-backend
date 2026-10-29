import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.guard';

/** Health endpoints are never authenticated (Desafio §2). Readiness arrives with S5-04. */
@Public()
@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
