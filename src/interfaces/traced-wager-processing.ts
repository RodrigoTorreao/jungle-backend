import type {
  ProcessWagerCommand,
  ProcessWagerTransactionUseCase,
} from '../application/use-cases/process-wager-transaction';
import type { WagerResult } from '../application/views';
import { inSpan, SpanKind } from '../infrastructure/observability/spans';

/**
 * The use case inside its own span, so a trace reads transport → use case → SQL. Shared by the
 * HTTP and SQS adapters; the use case itself stays free of tracing. No amounts in attributes.
 */
export function processWagerTraced(
  useCase: ProcessWagerTransactionUseCase,
  command: ProcessWagerCommand,
): Promise<WagerResult> {
  return inSpan(
    'ProcessWagerTransaction',
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        'wagering.kind': command.submission.kind,
        'wagering.provider_id': command.submission.providerId,
        'wagering.source': command.source,
        'wagering.correlation_id': command.correlationId,
      },
    },
    async (span) => {
      const result = await useCase.execute(command);
      span.setAttributes({
        'wagering.transaction_id': result.transactionId,
        'wagering.status': result.status,
        'wagering.idempotent_replay': result.idempotentReplay,
        ...(result.failureCode === undefined
          ? {}
          : { 'wagering.failure_code': result.failureCode }),
      });
      return result;
    },
  );
}
