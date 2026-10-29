import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { UnauthenticatedError } from '../../../application/errors';
import {
  PROVIDER_IDENTITY,
  type Principal,
  type ProviderIdentityPort,
} from '../../../application/ports/identity';

const PUBLIC_ROUTE = 'auth:public';

/** Marks a route (or controller) as reachable without credentials, e.g. health checks. */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

export type AuthenticatedRequest = Request & { principal?: Principal };

/** The caller resolved by the guard. Missing only if the guard did not run: treat as unauthenticated. */
export function principalOf(request: AuthenticatedRequest): Principal {
  if (request.principal === undefined) {
    throw new UnauthenticatedError('No principal resolved for this request');
  }
  return request.principal;
}

/**
 * Global guard: resolves the caller through the ProviderIdentityPort and attaches it to the
 * request. Authorization decisions (provider vs payload, backoffice-only routes) belong to the
 * use cases, not to this guard.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.principal = await this.identity.resolve({
      authorization: request.headers.authorization,
    });
    return true;
  }
}
