import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApplicationError,
  ConcurrencyConflictError,
  InvalidRequestError,
  InvariantBreachError,
  ResourceNotFoundError,
  TransientInfrastructureError,
  UnauthenticatedError,
  WalletAlreadyExistsError,
} from '../../application/errors';
import { InvalidMoneyError } from '../../domain/money/money';
import { DomainError, DomainValidationError } from '../../domain/shared/domain-error';
import { correlationIdOf, RequestValidationError } from './request';

export interface Problem {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly retryable: boolean;
  readonly errors?: readonly { path: string; message: string }[];
}

const RETRY_AFTER_SECONDS = '1';

/**
 * The single place where errors become HTTP (ARCHITECTURE §9.1). Every category gets its own
 * status so a provider never has to parse a message to decide whether to resend:
 *   400 invalid payload · 404 unknown resource · 409 conflict · 503 transient (Retry-After)
 *   500 invariant breach / unexpected. Business rejections (422) and pending (202) are
 *   regular responses of the wager endpoint, not errors.
 */
export function toProblem(error: unknown): Problem {
  if (error instanceof RequestValidationError) {
    return problem(400, error.code, 'Invalid request', error.message, false, error.issues);
  }
  if (
    error instanceof InvalidRequestError ||
    error instanceof DomainValidationError ||
    error instanceof InvalidMoneyError
  ) {
    return problem(400, error.code, 'Invalid request', error.message, false);
  }
  if (error instanceof UnauthenticatedError) {
    return problem(401, error.code, 'Unauthenticated', error.message, false);
  }
  if (error instanceof ResourceNotFoundError) {
    return problem(404, error.code, 'Not found', error.message, false);
  }
  if (error instanceof WalletAlreadyExistsError) {
    return problem(409, error.code, 'Conflict', error.message, false);
  }
  if (error instanceof TransientInfrastructureError || error instanceof ConcurrencyConflictError) {
    return problem(503, error.code, 'Temporarily unavailable', error.message, true);
  }
  if (error instanceof InvariantBreachError) {
    return problem(
      500,
      error.code,
      'Invariant violation',
      'The request was refused safely.',
      false,
    );
  }
  if (error instanceof ApplicationError || error instanceof DomainError) {
    return problem(500, error.code, 'Unexpected error', 'The request was refused safely.', false);
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code =
      status === HttpStatus.NOT_FOUND
        ? 'NOT_FOUND'
        : status === HttpStatus.BAD_REQUEST
          ? 'VALIDATION_ERROR'
          : 'HTTP_ERROR';
    return problem(status, code, error.name, error.message, false);
  }
  return problem(
    500,
    'INTERNAL_ERROR',
    'Unexpected error',
    'The request was refused safely.',
    false,
  );
}

function problem(
  status: number,
  code: string,
  title: string,
  detail: string,
  retryable: boolean,
  errors?: readonly { path: string; message: string }[],
): Problem {
  return { status, code, title, detail, retryable, ...(errors ? { errors } : {}) };
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const result = toProblem(error);
    const correlationId = correlationIdOf(request);

    if (result.status >= 500) {
      this.logger.error(
        { err: error, correlationId, code: result.code },
        `Request failed with ${result.code}`,
      );
    }
    if (result.retryable) {
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    }
    response
      .status(result.status)
      .type('application/problem+json')
      .json({
        type: `urn:jungle-wagering:problem:${result.code}`,
        title: result.title,
        status: result.status,
        code: result.code,
        detail: result.detail,
        retryable: result.retryable,
        instance: request.originalUrl,
        correlationId,
        ...(result.errors ? { errors: result.errors } : {}),
      });
  }
}
