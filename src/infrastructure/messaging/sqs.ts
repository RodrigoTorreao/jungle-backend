import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

export interface SqsConnection {
  readonly region: string;
  readonly endpointUrl: string | undefined;
}

/** SQS client; with AWS_ENDPOINT_URL set it talks to LocalStack. Credentials: default chain. */
export function createSqsClient(connection: SqsConnection): SQSClient {
  return new SQSClient({
    region: connection.region,
    ...(connection.endpointUrl === undefined ? {} : { endpoint: connection.endpointUrl }),
  });
}

/**
 * Resolves queue names to URLs once. Caching URLs is plain memoization of immutable metadata —
 * nothing here takes part in correctness.
 */
export class QueueDirectory {
  private readonly urls = new Map<string, Promise<string>>();

  constructor(readonly client: SQSClient) {}

  url(queueName: string): Promise<string> {
    let url = this.urls.get(queueName);
    if (url === undefined) {
      url = this.client
        .send(new GetQueueUrlCommand({ QueueName: queueName }))
        .then(({ QueueUrl }) => {
          if (QueueUrl === undefined) {
            throw new Error(`Queue ${queueName} has no URL`);
          }
          return QueueUrl;
        });
      url.catch(() => this.urls.delete(queueName));
      this.urls.set(queueName, url);
    }
    return url;
  }
}
