'use strict';

// This file must be loaded before anything else via --require.
// It patches Node.js modules at startup so auto-instrumentation can intercept them.

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-grpc');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { Resource } = require('@opentelemetry/resources');

const sdk = new NodeSDK({
  // Identifies this service in traces and metrics.
  // OTEL_SERVICE_NAME env var overrides this.
  resource: new Resource({
    'service.name': process.env.OTEL_SERVICE_NAME || 'node-app',
    'service.version': '1.0.0',
  }),

  // Traces: push spans to the OTel Collector via gRPC.
  // Uses OTEL_EXPORTER_OTLP_ENDPOINT env var for the endpoint.
  traceExporter: new OTLPTraceExporter(),

  // Metrics: push metrics to the OTel Collector every 15s.
  // The Collector re-exposes them in Prometheus format on port 8889.
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 15000,
  }),

  // Auto-instrumentation: zero-code spans for HTTP, Express, DNS, etc.
  // fs is disabled — it generates a span for every file read, which is overwhelming.
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

// Flush and shut down cleanly on container stop.
process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});
