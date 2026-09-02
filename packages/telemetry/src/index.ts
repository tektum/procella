// @procella/telemetry — OpenTelemetry instrumentation for Procella.
//
// Provides OTLP trace + metric export, Hono middleware, and span utilities.
// All instrumentation is no-op when disabled — safe to leave wired in production.

export { FetchOtlpTraceExporter } from "./fetch-exporter.js";
export {
	activeUpdatesGauge,
	authAuthenticateDuration,
	authFailureCount,
	type CompatApiBucket,
	type CompatCliBucket,
	type CompatCliMajorMinor,
	type CompatibilityRequestInput,
	type CompatResult,
	type CompatRouteClass,
	checkpointSizeHistogram,
	classifyApiVersion,
	classifyCliMajorMinor,
	classifyCliVersion,
	classifyResult,
	classifyRouteClass,
	compatibilityRequestCount,
	cryptoOperationCount,
	dbOperationCount,
	dbOperationDuration,
	gcCycleCount,
	gcOrphansCleanedCount,
	httpActiveRequestsGauge,
	httpRequestDuration,
	journalEntriesCount,
	recordCompatibilityRequest,
	storageOperationDuration,
	storageOperationSize,
	trpcProcedureDuration,
} from "./metrics.js";
export { FetchOtlpMetricExporter } from "./metrics-exporter.js";
export { activeContext, tracingMiddleware } from "./middleware.js";
export { initTelemetry, shutdownTelemetry, type TelemetryConfig } from "./sdk.js";
export { getTracer, withDbSpan, withSpan } from "./spans.js";
