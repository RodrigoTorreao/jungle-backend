import type { IncomingMessage } from 'node:http';
import { z } from 'zod';

/** Payload that does not match the HTTP contract. Mapped to 400 VALIDATION_ERROR. */
export class RequestValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';

  constructor(readonly issues: readonly { path: string; message: string }[]) {
    super(`Invalid request: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
    this.name = 'RequestValidationError';
  }
}

export function parseRequest<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RequestValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** Correlation id assigned by the logger middleware (echoed in x-correlation-id). */
export function correlationIdOf(request: IncomingMessage & { id?: unknown }): string {
  return typeof request.id === 'string' && request.id.length > 0 ? request.id : Bun.randomUUIDv7();
}

/** Money as it travels on the wire. The exact format is enforced by Money.from (INVALID_MONEY). */
export const MoneyBody = z.object({ amount: z.string(), currency: z.string() }).strict();

export const UuidParam = z.uuid();
