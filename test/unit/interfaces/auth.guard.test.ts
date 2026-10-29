import { describe, expect, test } from 'bun:test';
import { Controller, type ExecutionContext, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnauthenticatedError } from '../../../src/application/errors';
import type {
  Principal,
  ProviderIdentityPort,
  RequestCredentials,
} from '../../../src/application/ports/identity';
import { TrustedProviderIdentity } from '../../../src/infrastructure/auth/trusted-provider-identity';
import {
  type AuthenticatedRequest,
  AuthGuard,
  Public,
} from '../../../src/interfaces/http/auth/auth.guard';
import { toProblem } from '../../../src/interfaces/http/problem-details.filter';

@Controller('protected')
class ProtectedController {
  @Get()
  handler(): void {}

  @Public()
  @Get('open')
  openHandler(): void {}
}

@Public()
@Controller('public')
class PublicController {
  @Get()
  handler(): void {}
}

class RecordingIdentity implements ProviderIdentityPort {
  readonly calls: RequestCredentials[] = [];

  constructor(private readonly outcome: Principal | Error) {}

  async resolve(credentials: RequestCredentials): Promise<Principal> {
    this.calls.push(credentials);
    if (this.outcome instanceof Error) {
      throw this.outcome;
    }
    return this.outcome;
  }
}

function contextFor(
  controller: new () => object,
  handler: (...args: never[]) => void,
  request: Partial<AuthenticatedRequest>,
): ExecutionContext {
  return {
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const reflector = new Reflector();

describe('AuthGuard', () => {
  test('resolves the caller and attaches the principal to the request', async () => {
    const identity = new RecordingIdentity({ kind: 'provider', providerId: 'provider-a' });
    const request: Partial<AuthenticatedRequest> = { headers: { authorization: 'Bearer t' } };

    const allowed = await new AuthGuard(reflector, identity).canActivate(
      contextFor(ProtectedController, ProtectedController.prototype.handler, request),
    );

    expect(allowed).toBe(true);
    expect(identity.calls).toEqual([{ authorization: 'Bearer t' }]);
    expect(request.principal).toEqual({ kind: 'provider', providerId: 'provider-a' });
  });

  test('public routes and controllers skip the identity port', async () => {
    const identity = new RecordingIdentity(new UnauthenticatedError());
    const guard = new AuthGuard(reflector, identity);

    await expect(
      guard.canActivate(
        contextFor(ProtectedController, ProtectedController.prototype.openHandler, { headers: {} }),
      ),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(
        contextFor(PublicController, PublicController.prototype.handler, { headers: {} }),
      ),
    ).resolves.toBe(true);
    expect(identity.calls).toHaveLength(0);
  });

  test('invalid credentials surface as 401 UNAUTHENTICATED', async () => {
    const guard = new AuthGuard(reflector, new RecordingIdentity(new UnauthenticatedError()));
    const error = await guard
      .canActivate(
        contextFor(ProtectedController, ProtectedController.prototype.handler, { headers: {} }),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnauthenticatedError);
    expect(toProblem(error)).toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
      retryable: false,
    });
  });

  test('AUTH_MODE=disabled trusts every caller', async () => {
    expect(await new TrustedProviderIdentity().resolve()).toEqual({ kind: 'trusted' });
  });
});
