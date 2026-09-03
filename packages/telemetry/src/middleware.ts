// @procella/telemetry — Hono tracing middleware.
//
// Creates a span per HTTP request with standard semantic attributes.
// Propagates trace context so downstream spans (DB queries, crypto ops)
// are children of the request span.

import {
	context,
	propagation,
	type Span,
	SpanKind,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import {
	httpActiveRequestsGauge,
	httpRequestDuration,
	recordCompatibilityRequest,
} from "./metrics.js";

/**
 * Hono middleware that wraps each request in an OTLP span.
 * Extracts route pattern, method, status, and sets standard HTTP attributes.
 */
export function tracingMiddleware(): MiddlewareHandler {
	const tracer = trace.getTracer("procella.http");
	const durationHist = httpRequestDuration();
	const activeGauge = httpActiveRequestsGauge();

	return async (c, next) => {
		const method = c.req.method;
		const path = c.req.path;
		const spanName = `${method} ${path}`;
		const startTime = performance.now();

		const headers: Record<string, string> = {};
		c.req.raw.headers.forEach((value, key) => {
			headers[key] = value;
		});
		const parentCtx = propagation.extract(context.active(), headers);

		activeGauge.add(1);

		await tracer.startActiveSpan(
			spanName,
			{
				kind: SpanKind.SERVER,
				attributes: {
					"http.method": method,
					"http.url": c.req.url.split("?")[0],
					"http.target": path,
					"http.user_agent": c.req.header("user-agent") ?? "",
				},
			},
			parentCtx,
			async (span: Span) => {
				try {
					await next();

					const status = c.res.status;
					span.setAttribute("http.status_code", status);

					const routePath = c.req.routePath;
					if (routePath && routePath !== "/*") {
						span.updateName(`${method} ${routePath}`);
						span.setAttribute("http.route", routePath);
					}

					if (status >= 500) {
						span.setStatus({ code: SpanStatusCode.ERROR });
					} else {
						span.setStatus({ code: SpanStatusCode.OK });
					}
				} catch (err) {
					span.setStatus({
						code: SpanStatusCode.ERROR,
						message: err instanceof Error ? err.message : String(err),
					});
					span.recordException(err instanceof Error ? err : new Error(String(err)));
					throw err;
				} finally {
					const durationMs = performance.now() - startTime;
					const status = c.res?.status ?? 500;
					const routePath = c.req.routePath;
					const route = routePath && routePath !== "/*" ? routePath : path;
					durationHist.record(durationMs, {
						"http.method": method,
						"http.route": route,
						"http.status_code": status,
					});
					recordCompatibilityRequest({
						userAgent: c.req.header("user-agent"),
						accept: c.req.header("accept"),
						routePattern: routePath,
						status,
					});
					activeGauge.add(-1);
					span.end();
				}
			},
		);
	};
}

export function activeContext() {
	return context.active();
}
