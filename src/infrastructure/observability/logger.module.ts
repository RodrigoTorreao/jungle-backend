import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { stdTimeFunctions } from 'pino';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
const MAX_CORRELATION_ID_LENGTH = 128;

/** Paths never written to logs: credentials and financial values (ARCHITECTURE §10). */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.money',
  '*.amount',
  '*.balance',
  '*.balanceBefore',
  '*.balanceAfter',
  '*.initialBalance',
];

function resolveCorrelationId(req: IncomingMessage, res: ServerResponse): string {
  const header = req.headers[CORRELATION_ID_HEADER];
  const correlationId =
    typeof header === 'string' && header.length > 0 && header.length <= MAX_CORRELATION_ID_LENGTH
      ? header
      : Bun.randomUUIDv7();
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  return correlationId;
}

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          base: { service: 'wagering' },
          timestamp: stdTimeFunctions.isoTime,
          formatters: { level: (label: string) => ({ level: label }) },
          redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
          genReqId: resolveCorrelationId,
          customProps: (req: IncomingMessage & { id?: unknown }) => ({ correlationId: req.id }),
          autoLogging: {
            ignore: (req: IncomingMessage) => req.url?.startsWith('/health') ?? false,
          },
          serializers: {
            req: (req: IncomingMessage) => ({ method: req.method, url: req.url }),
            res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
          },
        },
      }),
    }),
  ],
})
export class LoggerModule {}
