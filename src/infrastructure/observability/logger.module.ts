import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { stdTimeFunctions } from 'pino';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { logContext } from './log-context';

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
  '*.storedBalance',
  '*.calculatedBalance',
  '*.difference',
];

type RequestWithId = IncomingMessage & { id?: unknown };

/** The caller's x-correlation-id when sane, a new UUIDv7 otherwise; echoed in the response. */
export function resolveCorrelationId(req: RequestWithId, res: ServerResponse): string {
  if (typeof req.id === 'string') {
    return req.id;
  }
  const header = req.headers[CORRELATION_ID_HEADER];
  const correlationId =
    typeof header === 'string' && header.length > 0 && header.length <= MAX_CORRELATION_ID_LENGTH
      ? header
      : Bun.randomUUIDv7();
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  req.id = correlationId;
  return correlationId;
}

/**
 * Express middleware opening the log context of one request. Registered with `app.use` before
 * Nest's own middleware, so everything downstream — pino-http included — runs inside it.
 */
export function correlationMiddleware(
  req: RequestWithId,
  res: ServerResponse,
  next: () => void,
): void {
  const correlationId = resolveCorrelationId(req, res);
  logContext.run({ correlationId }, next);
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
          // Stamps correlationId, messageId, transactionId, walletId, providerId on every line.
          mixin: () => ({ ...logContext.current() }),
          redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
          genReqId: resolveCorrelationId,
          customProps: (req: RequestWithId) => ({ correlationId: req.id }),
          autoLogging: {
            ignore: (req: IncomingMessage) =>
              (req.url?.startsWith('/health') || req.url?.startsWith('/metrics')) ?? false,
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
