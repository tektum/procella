import { describe, expect, test } from "bun:test";
import type { AuthService } from "@procella/auth";
import type { StacksService } from "@procella/stacks";
import type { Caller } from "@procella/types";
import { StackNotFoundError, UnauthorizedError } from "@procella/types";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { apiAuth, updateAuth } from "./auth.js";
import { errorHandler } from "./error-handler.js";
import { requestLogger } from "./logging.js";
import { pulumiAccept } from "./pulumi-accept.js";

// ============================================================================
// Mock AuthService
// ============================================================================

const validCaller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "u-1",
	login: "test-user",
	roles: ["admin"],
	principalType: "user",
};

function mockAuthService(opts?: { failAuth?: boolean }): AuthService {
	return {
		authenticate: async () => {
			if (opts?.failAuth) {
				throw new UnauthorizedError("Invalid token");
			}
			return validCaller;
		},
		authenticateUpdateToken: async (token: string) => {
			const parts = token.split(":");
			if (parts.length !== 4 || parts[0] !== "update") {
				throw new UnauthorizedError("Invalid update token");
			}
			return { updateId: parts[1], stackId: parts[2] };
		},
		resolveUserDisplayName: async () => null,
	};
}

function mockStacksService(stackId = "sid-1"): Pick<StacksService, "getStackById_systemOnly"> {
	return {
		getStackById_systemOnly: async () => ({
			id: stackId,
			projectId: "p-1",
			tenantId: "t-1",
			orgName: "my-org",
			projectName: "myproj",
			stackName: "dev",
			tags: {},
			activeUpdateId: null,
			lastUpdate: null,
			resourceCount: null,
			createdAt: new Date("2025-01-01T00:00:00Z"),
			updatedAt: new Date("2025-01-01T00:00:00Z"),
		}),
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("@procella/server middleware", () => {
	// ========================================================================
	// apiAuth
	// ========================================================================

	describe("apiAuth", () => {
		test("sets caller on context for valid token", async () => {
			const app = new Hono<Env>();
			app.use("*", apiAuth(mockAuthService()));
			app.get("/test", (c) => c.json(c.get("caller")));

			const res = await app.request("/test", {
				headers: { Authorization: "token valid-token" },
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.login).toBe("test-user");
		});

		test("returns 401 for invalid token", async () => {
			const app = new Hono<Env>();
			app.use("*", apiAuth(mockAuthService({ failAuth: true })));
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Authorization: "token bad" },
			});
			expect(res.status).toBe(401);
		});

		test("returns 401 for missing Authorization header", async () => {
			const app = new Hono<Env>();
			app.use("*", apiAuth(mockAuthService({ failAuth: true })));
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test");
			expect(res.status).toBe(401);
		});
	});

	// ========================================================================
	// updateAuth
	// ========================================================================

	describe("updateAuth", () => {
		const stubVerifier = async () => {};

		test("sets updateContext for valid update-token", async () => {
			const app = new Hono<Env>();
			app.use("*", updateAuth(mockAuthService(), stubVerifier, mockStacksService()));
			app.get("/test", (c) => c.json(c.get("updateContext")));

			const res = await app.request("/test", {
				headers: {
					Authorization:
						"update-token update:uid-1:sid-1:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
				},
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.updateId).toBe("uid-1");
			expect(body.stackId).toBe("sid-1");
		});

		test("returns 401 for missing update-token", async () => {
			const app = new Hono<Env>();
			app.use("*", updateAuth(mockAuthService(), stubVerifier, mockStacksService()));
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test");
			expect(res.status).toBe(401);
		});

		test("returns 401 for malformed token", async () => {
			const app = new Hono<Env>();
			app.use("*", updateAuth(mockAuthService(), stubVerifier, mockStacksService()));
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Authorization: "update-token bad-format" },
			});
			expect(res.status).toBe(401);
		});
	});

	// ========================================================================
	// pulumiAccept
	// ========================================================================

	describe("pulumiAccept", () => {
		test("allows request with correct Accept header", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Accept: "application/vnd.pulumi+8" },
			});
			expect(res.status).toBe(200);
		});

		test("rejects request without Accept header", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test");
			expect(res.status).toBe(415);
		});

		test("allows Accept header with additional types", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Accept: "application/vnd.pulumi+8, application/json" },
			});
			expect(res.status).toBe(200);
		});

		test("allows newer API versions (v9 from Pulumi CLI v3.233+)", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Accept: "application/vnd.pulumi+9" },
			});
			expect(res.status).toBe(200);
		});

		test("allows future API versions (forward-compatible)", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Accept: "application/vnd.pulumi+42" },
			});
			expect(res.status).toBe(200);
		});

		test("rejects older API versions below v8", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Accept: "application/vnd.pulumi+7" },
			});
			expect(res.status).toBe(415);
		});

		test("rejects non-Pulumi Accept header", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Accept: "application/json" },
			});
			expect(res.status).toBe(415);
		});

		// Regression: a multi-value Accept header with an old version FIRST and a
		// supported version SECOND must be accepted. Earlier versions of this
		// middleware used `match()` (first occurrence only) and would reject
		// here. See PR #160 review feedback.
		test("accepts multiple Pulumi versions when any is supported (old first)", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Accept: "application/vnd.pulumi+7, application/vnd.pulumi+9" },
			});
			expect(res.status).toBe(200);
		});

		// Regression: a multi-value Accept header where EVERY advertised version
		// is below MIN_API_VERSION must still be rejected — the middleware must
		// not be tricked by simply seeing "application/vnd.pulumi+" anywhere.
		test("rejects multiple Pulumi versions when all are below v8", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Accept: "application/vnd.pulumi+6, application/vnd.pulumi+7" },
			});
			expect(res.status).toBe(415);
		});

		// Regression: per RFC 9110 §8.3.2 media types are case-insensitive.
		// Earlier versions of this regex used no `i` flag and would reject
		// `Application/Vnd.Pulumi+8` as if it were a non-Pulumi header.
		test("accepts case-insensitive Pulumi media type", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Accept: "Application/Vnd.Pulumi+8" },
			});
			expect(res.status).toBe(200);
		});

		// Regression: without a media-range boundary (`;`, `,`, or end-of-string)
		// after the version digits, `application/vnd.pulumi+8evil` would match
		// the leading "8" and be accepted as v8. The current regex requires a
		// proper boundary so junk-suffix media types are rejected.
		test("rejects malformed media type with garbage suffix", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Accept: "application/vnd.pulumi+8evil" },
			});
			expect(res.status).toBe(415);
		});

		// Regression: when a header mixes a junk-suffix range with a valid
		// range, only the valid one should be considered. Earlier versions of
		// the regex would emit BOTH versions (treating `+8evil` as 8), which
		// happens to still pass MIN here but is semantically wrong and would
		// mask configuration mistakes.
		test("ignores garbage-suffix range and uses only well-formed versions", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Accept: "application/vnd.pulumi+8evil, application/vnd.pulumi+9" },
			});
			expect(res.status).toBe(200);
		});

		// Regression: media types may have parameters (`;q=0.9`, `;charset=...`)
		// per RFC 9110 §8.3.1. A header like `application/vnd.pulumi+8;q=0.9`
		// must be accepted — the boundary check uses `;` as a valid terminator.
		test("accepts media type with quality parameter", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Accept: "application/vnd.pulumi+8;q=0.9" },
			});
			expect(res.status).toBe(200);
		});
	});

	// ========================================================================
	// errorHandler (uses app.onError)
	// ========================================================================

	describe("errorHandler", () => {
		test("maps ProcellaError to correct status code", async () => {
			const app = new Hono();
			app.onError(errorHandler());
			app.get("/test", () => {
				throw new StackNotFoundError("org", "proj", "dev");
			});

			const res = await app.request("/test");
			expect(res.status).toBe(404);
			const body = await res.json();
			expect(body.code).toBe(404);
			expect(body.message).toContain("not found");
		});

		test("maps unknown error to 500", async () => {
			const app = new Hono();
			app.onError(errorHandler());
			app.get("/test", () => {
				throw new Error("unexpected");
			});

			const res = await app.request("/test");
			expect(res.status).toBe(500);
			const body = await res.json();
			expect(body.code).toBe(500);
			expect(body.message).toBe("Internal server error");
		});

		test("returns ErrorResponse shape", async () => {
			const app = new Hono();
			app.onError(errorHandler());
			app.get("/test", () => {
				throw new UnauthorizedError("bad creds");
			});

			const res = await app.request("/test");
			const body = await res.json();
			expect(body).toHaveProperty("code");
			expect(body).toHaveProperty("message");
		});

		test("maps PG serialization_failure (40001) to 503 with Retry-After (procella-fkf)", async () => {
			const app = new Hono();
			app.onError(errorHandler());
			app.get("/test", () => {
				throw Object.assign(new Error("could not serialize access due to concurrent update"), {
					code: "40001",
				});
			});

			const res = await app.request("/test");
			expect(res.status).toBe(503);
			expect(res.headers.get("Retry-After")).toBe("1");
			const body = (await res.json()) as {
				code: number;
				error: string;
				sqlState: string;
				message: string;
			};
			expect(body.code).toBe(503);
			expect(body.error).toBe("transient_conflict");
			expect(body.sqlState).toBe("40001");
		});

		test("maps PG deadlock_detected (40P01) to 503 with Retry-After (procella-fkf)", async () => {
			const app = new Hono();
			app.onError(errorHandler());
			app.get("/test", () => {
				throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
			});

			const res = await app.request("/test");
			expect(res.status).toBe(503);
			expect(res.headers.get("Retry-After")).toBe("1");
			const body = (await res.json()) as {
				code: number;
				error: string;
				sqlState: string;
				message: string;
			};
			expect(body.code).toBe(503);
			expect(body.error).toBe("transient_conflict");
			expect(body.sqlState).toBe("40P01");
		});

		test("non-transient PG error (e.g. unique_violation 23505) still maps to 500", async () => {
			const app = new Hono();
			app.onError(errorHandler());
			app.get("/test", () => {
				throw Object.assign(new Error("unique constraint violation"), { code: "23505" });
			});

			const res = await app.request("/test");
			expect(res.status).toBe(500);
			expect(res.headers.get("Retry-After")).toBeNull();
		});

		test("transient PG error wrapped in AggregateError still maps to 503", async () => {
			const app = new Hono();
			app.onError(errorHandler());
			app.get("/test", () => {
				const inner = Object.assign(new Error("deadlock"), { code: "40P01" });
				throw new AggregateError([inner], "wrapped");
			});

			const res = await app.request("/test");
			expect(res.status).toBe(503);
			expect(res.headers.get("Retry-After")).toBe("1");
		});
	});

	// ========================================================================
	// requestLogger
	// ========================================================================

	describe("requestLogger", () => {
		test("calls next and does not block", async () => {
			const app = new Hono();
			app.use("*", requestLogger());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test");
			expect(res.status).toBe(200);
		});
	});
});
