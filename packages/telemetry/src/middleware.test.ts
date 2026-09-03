import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { activeContext, tracingMiddleware } from "./middleware.js";

describe("@procella/telemetry middleware", () => {
	function createApp() {
		const app = new Hono();
		app.use("*", tracingMiddleware());
		app.get("/test", (c) => c.json({ ok: true }));
		app.get("/items/:id", (c) => c.json({ id: c.req.param("id") }));
		app.post("/create", (c) => c.json({ created: true }));
		app.get("/error", () => {
			throw new Error("test error");
		});
		app.get("/server-error", (c) => c.json({ error: true }, 500));
		app.onError((_err, c) => c.json({ error: "caught" }, 500));
		return app;
	}

	test("passes through successful requests", async () => {
		const app = createApp();
		const res = await app.request("/test");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test("handles parameterized routes", async () => {
		const app = createApp();
		const res = await app.request("/items/42");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.id).toBe("42");
	});

	test("handles POST requests", async () => {
		const app = createApp();
		const res = await app.request("/create", { method: "POST" });
		expect(res.status).toBe(200);
	});

	test("propagates errors and records exception", async () => {
		const app = createApp();
		const res = await app.request("/error");
		expect(res.status).toBe(500);
	});

	test("records 500 status without throwing", async () => {
		const app = createApp();
		const res = await app.request("/server-error");
		expect(res.status).toBe(500);
	});

	test("handles 404 for unmatched routes", async () => {
		const app = createApp();
		const res = await app.request("/nonexistent");
		expect(res.status).toBe(404);
	});

	test("passes W3C trace context headers", async () => {
		const app = createApp();
		const res = await app.request("/test", {
			headers: {
				traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
			},
		});
		expect(res.status).toBe(200);
	});
});

describe("@procella/telemetry middleware — compatibility telemetry wiring", () => {
	function createApp() {
		const app = new Hono();
		app.use("*", tracingMiddleware());
		app.get("/api/stacks/:org/:project/:stack", (c) => c.json({ ok: true }));
		app.post(
			"/api/stacks/:org/:project/:stack/batch-encrypt",
			(c) => c.json({ ok: true }, 415), // simulates pulumiAccept()'s 415 rejection downstream
		);
		return app;
	}

	test("records without altering the response for a current-format Pulumi CLI request", async () => {
		const app = createApp();
		const res = await app.request("/api/stacks/acme/proj/dev", {
			headers: {
				"User-Agent": "pulumi-cli/1 (3.233.0; linux)",
				Accept: "application/vnd.pulumi+9",
			},
		});
		expect(res.status).toBe(200);
	});

	test("records without altering the response for a legacy Pulumi CLI request with no Accept header", async () => {
		const app = createApp();
		const res = await app.request("/api/stacks/acme/proj/dev", {
			headers: { "User-Agent": "pulumi-cli/3.9.0" },
		});
		expect(res.status).toBe(200);
	});

	test("records without altering a version-gated route's 415 rejection", async () => {
		const app = createApp();
		const res = await app.request("/api/stacks/acme/proj/dev/batch-encrypt", {
			method: "POST",
			headers: { "User-Agent": "pulumi-cli/3.9.0" },
		});
		expect(res.status).toBe(415);
	});

	test("records without throwing for non-CLI, malformed, and unmatched requests", async () => {
		const app = createApp();
		const malformedAccept = await app.request("/api/stacks/acme/proj/dev", {
			headers: { Accept: "application/vnd.pulumi+abc" },
		});
		expect(malformedAccept.status).toBe(200);

		const nonCli = await app.request("/api/stacks/acme/proj/dev", {
			headers: { "User-Agent": "Mozilla/5.0" },
		});
		expect(nonCli.status).toBe(200);

		const unmatched = await app.request("/nonexistent", {
			headers: { "User-Agent": "pulumi-cli/1 (3.9.0; linux)" },
		});
		expect(unmatched.status).toBe(404);
	});
});

describe("activeContext", () => {
	test("returns a context object", () => {
		const ctx = activeContext();
		expect(ctx).toBeDefined();
	});
});
