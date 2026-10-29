import { type Attributes, type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('wagering');

export { SpanKind };

/**
 * Runs `work` inside an active span (a no-op span when tracing is off), so the SQL it issues
 * nests under it. Errors are recorded on the span and rethrown. Attributes must never carry
 * amounts or balances — the same rule as logs.
 */
export function inSpan<T>(
  name: string,
  options: { kind: SpanKind; attributes?: Attributes },
  work: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, options, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** trace_id/span_id of the active span, to stamp on log lines (empty when tracing is off). */
export function activeTraceIds(): { traceId?: string; spanId?: string } {
  const context = trace.getActiveSpan()?.spanContext();
  if (context === undefined || !trace.isSpanContextValid(context)) {
    return {};
  }
  return { traceId: context.traceId, spanId: context.spanId };
}
