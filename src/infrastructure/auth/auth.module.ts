import { Global, Module } from '@nestjs/common';
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from '../../application/ports/identity';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { TrustedProviderIdentity } from './trusted-provider-identity';

/** Picks the identity adapter for the configured AUTH_MODE. */
@Global()
@Module({
  providers: [
    {
      provide: PROVIDER_IDENTITY,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): ProviderIdentityPort => {
        switch (config.auth.mode) {
          case 'disabled':
            return new TrustedProviderIdentity();
        }
      },
    },
  ],
  exports: [PROVIDER_IDENTITY],
})
export class AuthModule {}
