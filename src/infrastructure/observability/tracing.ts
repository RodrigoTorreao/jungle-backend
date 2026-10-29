/**
 * OpenTelemetry tracing (D-05), opt-in: only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 *
 * Imported first by main.ts, before anything loads `http` or `pg`: the instrumentations patch
 * modules as they are `require`d (Nest/Express and node-postgres are CommonJS, so this works
 * under Bun exactly as under Node — verified in a spike, DECISION_LOG DL-025). ESM-only modules
 * such as the AWS SDK v3 are not patched, so SQS spans are manual (consumer, outbox relay).
 *
 * A request produces: HTTP server span → pg spans of its SQL transaction. Events published
 * later by the outbox relay are a separate trace, joined by the `wagering.correlation_id`
 * attribute; carrying the trace context through the outbox row is a known limitation.
 */
import type { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const NOISE = ['/health', '/metrics'];

function startTracing(): NodeTracerProvider | undefined {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return undefined;
  }
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'wagering',
    }),
    // The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT itself (…/v1/traces is appended).
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new HttpInstrumentation({
        // Probes and scrapes every few seconds would bury the real traffic.
        ignoreIncomingRequestHook: (request: IncomingMessage) =>
          NOISE.some((path) => request.url?.startsWith(path) ?? false),
        // Outgoing calls are the AWS SDK's own (fetch-based, not patched) and the OTLP exporter.
        disableOutgoingRequestInstrumentation: true,
      }),
      // Idle worker polls have no parent span: dropping them keeps traces about real work.
      new PgInstrumentation({ requireParentSpan: true }),
    ],
  });
  // MikroORM imports pg's ESM entry, which the require hook never sees; that entry re-exports
  // the CommonJS lib, so requiring it once here patches the very prototypes MikroORM will use.
  createRequire(import.meta.url)('pg');
  return provider;
}

export const tracerProvider = startTracing();
