/**
 * OpenTelemetry SDK initialization.
 *
 * MUST be imported before any other application module in orchestrator.ts —
 * the HTTP instrumentation monkey-patches node:http at import time.
 */

import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { Resource } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

const sdk = new NodeSDK({
	resource: new Resource({
		[ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "sandbox-mgmt",
		[ATTR_SERVICE_VERSION]: "0.1.0-spike",
	}),
	traceExporter: new OTLPTraceExporter({
		url: `${endpoint}/v1/traces`,
	}),
	metricReader: new PeriodicExportingMetricReader({
		exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
		exportIntervalMillis: 10_000,
	}),
	instrumentations: [new HttpInstrumentation()],
});

sdk.start();
console.error(`[telemetry] OTEL SDK started, exporting traces + metrics to ${endpoint}`);

// Observability is best effort. Signal listeners run independently of the
// orchestrator's durable drain; an exporter rejection must not terminate it.
let shutdownStarted = false;
const shutdownOtel = async () => {
	if (shutdownStarted) return;
	shutdownStarted = true;
	try {
		await sdk.shutdown();
	} catch {
		console.warn("[telemetry] SDK shutdown export failed; continuing host drain");
	}
};

process.on("SIGTERM", shutdownOtel);
process.on("SIGINT", shutdownOtel);

export { sdk };
