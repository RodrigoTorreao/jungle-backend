import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { EVENT_PUBLISHER } from '../../application/ports/messaging';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { createSqsClient, QueueDirectory } from './sqs';
import { SqsEventPublisher } from './sqs-event-publisher';

@Global()
@Module({
  providers: [
    {
      provide: QueueDirectory,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new QueueDirectory(createSqsClient(config.aws)),
    },
    {
      provide: EVENT_PUBLISHER,
      inject: [QueueDirectory, APP_CONFIG],
      useFactory: (queues: QueueDirectory, config: AppConfig) =>
        new SqsEventPublisher(queues, config.sqs.eventsQueue),
    },
  ],
  exports: [QueueDirectory, EVENT_PUBLISHER],
})
export class MessagingModule implements OnApplicationShutdown {
  constructor(@Inject(QueueDirectory) private readonly queues: QueueDirectory) {}

  onApplicationShutdown(): void {
    this.queues.client.destroy();
  }
}
