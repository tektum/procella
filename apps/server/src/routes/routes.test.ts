import { describe, expect, test } from "bun:test";
import type { AuditService } from "@procella/audit";
import type { AuthService } from "@procella/auth";
import type { Database } from "@procella/db";
import type { EscService } from "@procella/esc";
import type { StackInfo, StacksService } from "@procella/stacks";
import type { Caller } from "@procella/types";
import { UnauthorizedError } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { CreateWebhookInput, WebhookEventValue, WebhooksService } from "@procella/webhooks";
import { SignJWT } from "jose";
import { INTERNAL_CLIENT_IP_HEADER } from "../middleware/security.js";
import { createSubscriptionTicketService } from "../subscription-tickets.js";
import { createApp } from "./index.js";

const subscriptionTickets = createSubscriptionTicketService(
	"ticket-signing-key-ticket-signing-key",
);

// ============================================================================
// Mock Data
// ============================================================================

const validCaller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "u-1",
	login: "test-user",
	roles: ["admin"],
	principalType: "user",
};

const mockStackInfo: StackInfo = {
	id: "stack-uuid-1",
	projectId: "proj-uuid-1",
	tenantId: "t-1",
	orgName: "myorg",
	projectName: "myproj",
	stackName: "dev",
	tags: {},
	activeUpdateId: null,
	lastUpdate: null,
	resourceCount: null,
	createdAt: new Date("2025-01-01"),
	updatedAt: new Date("2025-01-01"),
};

// ============================================================================
// Mock Services
// ============================================================================

function mockAuthService(): AuthService {
	return {
		authenticate: async (request: Request) => {
			const header = request.headers.get("Authorization");
			if (!header?.startsWith("token ")) {
				throw new UnauthorizedError("Missing or invalid Authorization header");
			}
			const token = header.slice("token ".length);
			if (token !== "valid-token") {
				throw new UnauthorizedError("Invalid token");
			}
			return validCaller;
		},
		createCliAccessKey: async (_caller: Caller, name: string) => `cli-token:${name}`,
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

function mockStacksService(): StacksService {
	return {
		createStack: async () => mockStackInfo,
		getStack: async () => mockStackInfo,
		listStacks: async () => [mockStackInfo],
		deleteStack: async () => {},
		renameStack: async () => {},
		updateStackTags: async () => {},
		replaceStackTags: async () => {},
		getStackByFQN: async () => mockStackInfo,
		getStackByNames_systemOnly: async () => mockStackInfo,
		getStackById_systemOnly: async () => mockStackInfo,
	};
}

function mockUpdatesService(): UpdatesService {
	return {
		createUpdate: async () => ({ updateID: "upd-1" }),
		startUpdate: async () => ({
			version: 1,
			token: "lease-token",
			tokenExpiration: Date.now() + 300_000,
		}),
		completeUpdate: async () => {},
		cancelUpdate: async () => {},
		patchCheckpoint: async () => {},
		patchCheckpointVerbatim: async () => {},
		patchCheckpointDelta: async () => {},
		postEvents: async () => {},
		renewLease: async () => ({ token: "new-token" }),
		getUpdate: async () => ({
			status: "succeeded",
			events: [],
			startTime: Date.now(),
		}),
		getUpdateEvents: async () => ({ events: [] }),
		getHistory: async () => ({ updates: [] }),
		exportStack: async () => ({ version: 3, deployment: {} }),
		importStack: async () => ({ updateId: "imp-1" }),
		encryptValue: async () => new Uint8Array([1, 2, 3]),
		decryptValue: async () => new Uint8Array([4, 5, 6]),
		batchEncrypt: async () => [new Uint8Array([1])],
		batchDecrypt: async () => [new Uint8Array([2])],
		verifyLeaseToken: async () => {},
		verifyUpdateOwnership: async () => {},
	} as unknown as UpdatesService;
}

function mockAuditService(): AuditService {
	return {
		log: () => {},
		query: async () => ({ entries: [], total: 0 }),
		export: async () => [],
	};
}

function mockWebhooksService(): WebhooksService {
	return {
		createWebhook: async (_tenantId: string, input: CreateWebhookInput, createdBy: string) => ({
			id: "hook-1",
			name: input.name,
			url: input.url,
			events: input.events,
			active: true,
			createdBy,
			createdAt: new Date("2025-01-01"),
			updatedAt: new Date("2025-01-01"),
			secret: input.secret ?? "generated-secret",
		}),
		listWebhooks: async () => [],
		getWebhook: async () => null,
		updateWebhook: async (
			_tenantId: string,
			webhookId: string,
			updates: Partial<CreateWebhookInput>,
		) => ({
			id: webhookId,
			name: updates.name ?? "hook",
			url: updates.url ?? "https://example.com/hook",
			events: updates.events ?? ["stack.created"],
			active: true,
			createdBy: "u-1",
			createdAt: new Date("2025-01-01"),
			updatedAt: new Date("2025-01-01"),
		}),
		deleteWebhook: async () => {},
		listDeliveries: async (_tenantId: string, _webhookId: string, _limit?: number) => [],
		emit: (_event: {
			tenantId: string;
			event: WebhookEventValue;
			data: Record<string, unknown>;
		}) => {},
		emitAndWait: async (_event: {
			tenantId: string;
			event: WebhookEventValue;
			data: Record<string, unknown>;
		}) => {},
		ping: async () => ({
			id: "delivery-1",
			event: "webhook.ping",
			responseStatus: 200,
			success: true,
			attempt: 1,
			error: null,
			duration: 10,
			createdAt: new Date("2025-01-01"),
		}),
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("@procella/server routes", () => {
	function makeApp(
		authConfig: import("@procella/auth").AuthConfig = {
			mode: "dev",
			token: "valid-token",
			userLogin: "test-user",
			orgLogin: "test-org",
		},
		opts?: {
			corsOrigins?: string[];
			cronSecret?: string;
			issueSubscriptionTicket?: (caller: Caller) => Promise<string>;
			verifySubscriptionTicket?: (ticket: string) => Promise<Caller>;
		},
	) {
		return createApp({
			auth: mockAuthService(),
			authConfig,
			audit: mockAuditService(),
			db: { execute: async () => ({ rows: [{ acquired: false }] }) } as unknown as Database,
			dbUrl: "postgres://test:test@localhost:5432/test",
			cronSecret: opts?.cronSecret,
			corsOrigins: opts?.corsOrigins,
			github: null,
			githubWebhookSecret: undefined,
			issueSubscriptionTicket:
				opts?.issueSubscriptionTicket ??
				((caller: Caller) => subscriptionTickets.issueTicket(caller)),
			stacks: mockStacksService(),
			updates: mockUpdatesService(),
			webhooks: mockWebhooksService(),
			verifySubscriptionTicket:
				opts?.verifySubscriptionTicket ??
				((ticket: string) => subscriptionTickets.verifyTicket(ticket)),
			esc: {
				listProjects: async () => [],
				listAllEnvironments: async () => ({ environments: [], nextToken: "" }),
				createEnvironment: async () => ({}),
				cloneEnvironment: async () => ({}),
				listEnvironments: async () => [],
				getEnvironment: async () => null,
				updateEnvironment: async () => ({}),
				deleteEnvironment: async () => {},
				listRevisions: async () => [],
				getRevision: async () => null,
				openSession: async () => ({}),
				getSession: async () => null,
				gcSweep: async () => ({ closedCount: 0 }),
				listRevisionTags: async () => [],
				tagRevision: async () => {},
				untagRevision: async () => {},
				getEnvironmentTags: async () => ({}),
				setEnvironmentTags: async () => {},
				updateEnvironmentTags: async () => {},
				createDraft: async () => ({}),
				listDrafts: async () => [],
				updateDraft: async () => ({}),
				getDraft: async () => null,
				applyDraft: async () => ({}),
				discardDraft: async () => {},
				validateYaml: async () => ({ values: {}, diagnostics: [] }),
			} as unknown as EscService,
		});
	}

	const authHeaders = {
		Authorization: "token valid-token",
		Accept: "application/vnd.pulumi+8",
	};

	// ========================================================================
	// Public routes (no auth required)
	// ========================================================================

	describe("public routes", () => {
		test("responses include security headers", async () => {
			const app = makeApp();
			const res = await app.request("/healthz");

			expect(res.status).toBe(200);
			expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
			expect(res.headers.get("x-frame-options")).toBe("DENY");
			expect(res.headers.get("referrer-policy")).toBe("no-referrer");
			expect(res.headers.get("strict-transport-security")).toBe(
				"max-age=31536000; includeSubDomains",
			);
		});

		test("GET /healthz returns 200 without auth", async () => {
			const app = makeApp();
			const res = await app.request("/healthz");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.status).toBe("ok");
		});

		test("GET /api/capabilities returns 200 without auth", async () => {
			const app = makeApp();
			const res = await app.request("/api/capabilities");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.capabilities).toBeArray();
		});

		test("GET /api/cli/version returns 200 without auth", async () => {
			const app = makeApp();
			const res = await app.request("/api/cli/version");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toHaveProperty("latestVersion");
		});

		test("GET /api/auth/config returns dev mode config", async () => {
			const app = makeApp();
			const res = await app.request("/api/auth/config");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({ mode: "dev" });
		});

		test("GET /api/auth/config returns descope mode config with projectId", async () => {
			const app = makeApp({ mode: "descope", projectId: "P3test123" });
			const res = await app.request("/api/auth/config");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({ mode: "descope", projectId: "P3test123" });
		});

		test("GET /api/auth/config includes authBaseUrl when a custom auth domain is configured", async () => {
			const app = makeApp({
				mode: "descope",
				projectId: "P3test123",
				authBaseUrl: "https://auth.procella.cloud",
			});
			const res = await app.request("/api/auth/config");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({
				mode: "descope",
				projectId: "P3test123",
				authBaseUrl: "https://auth.procella.cloud",
			});
		});
	});

	// ========================================================================
	// Cron GC endpoint
	// ========================================================================

	describe("GET /cron/gc", () => {
		test("returns 401 when cron secret is missing", async () => {
			const app = makeApp(undefined, { cronSecret: undefined });
			const res = await app.request("/cron/gc");
			expect(res.status).toBe(401);
		});

		test("returns 401 with wrong Bearer token", async () => {
			const app = makeApp(undefined, { cronSecret: "correct-secret" });
			const res = await app.request("/cron/gc", {
				headers: { Authorization: "Bearer wrong-secret" },
			});
			expect(res.status).toBe(401);
		});

		test("returns 200 with correct Bearer token", async () => {
			const app = makeApp(undefined, { cronSecret: "correct-secret" });
			const res = await app.request("/cron/gc", {
				headers: { Authorization: "Bearer correct-secret" },
			});
			expect(res.status).toBe(200);
		});
	});

	describe("CORS middleware", () => {
		test("is not mounted when no origins configured", async () => {
			const app = makeApp(undefined, { corsOrigins: [] });
			const res = await app.request("/healthz", {
				headers: { Origin: "https://evil.example" },
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("access-control-allow-origin")).toBeNull();
		});
	});

	// ========================================================================
	// Auth enforcement
	// ========================================================================

	describe("auth enforcement", () => {
		test("GET /api/user returns 401 without auth", async () => {
			const app = makeApp();
			const res = await app.request("/api/user", {
				headers: { Accept: "application/vnd.pulumi+8" },
			});
			expect(res.status).toBe(401);
		});

		test("GET /api/stacks returns 401 without auth", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks", {
				headers: { Accept: "application/vnd.pulumi+8" },
			});
			expect(res.status).toBe(401);
		});

		test("GET /trpc SSE endpoint returns 401 without a ticket", async () => {
			const app = makeApp(undefined, {
				verifySubscriptionTicket: async () => validCaller,
			});
			const res = await app.request(
				"/trpc/updates.onEvents?input=%7B%22org%22%3A%22my-org%22%2C%22project%22%3A%22myproj%22%2C%22stack%22%3A%22dev%22%2C%22updateId%22%3A%22upd-1%22%7D",
			);

			expect(res.status).toBe(401);
		});

		test("GET /trpc SSE endpoint returns invalid_ticket for bad signatures", async () => {
			const app = makeApp(undefined, {
				verifySubscriptionTicket: (ticket: string) => subscriptionTickets.verifyTicket(ticket),
			});
			const badTicket = await createSubscriptionTicketService(
				"wrong-ticket-signing-key-wrong-key",
			).issueTicket(validCaller);
			const res = await app.request(
				`/trpc/updates.onEvents?ticket=${encodeURIComponent(badTicket)}&input=%7B%22org%22%3A%22my-org%22%2C%22project%22%3A%22myproj%22%2C%22stack%22%3A%22dev%22%2C%22updateId%22%3A%22upd-1%22%7D`,
			);

			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ code: "invalid_ticket" });
		});

		test("GET /trpc SSE endpoint returns invalid_ticket for expired tickets", async () => {
			const app = makeApp(undefined, {
				verifySubscriptionTicket: (ticket: string) => subscriptionTickets.verifyTicket(ticket),
			});
			const expiredTicket = await new SignJWT({
				tenantId: validCaller.tenantId,
				orgSlug: validCaller.orgSlug,
				userId: validCaller.userId,
				login: validCaller.login,
				roles: [...validCaller.roles],
				principalType: validCaller.principalType,
			})
				.setProtectedHeader({ alg: "HS256", typ: "JWT" })
				.setIssuer("procella")
				.setAudience("procella:trpc-subscription")
				.setIssuedAt(Math.floor(Date.now() / 1000) - 120)
				.setExpirationTime(Math.floor(Date.now() / 1000) - 60)
				.sign(new TextEncoder().encode("ticket-signing-key-ticket-signing-key"));
			const res = await app.request(
				`/trpc/updates.onEvents?ticket=${encodeURIComponent(expiredTicket)}&input=%7B%22org%22%3A%22my-org%22%2C%22project%22%3A%22myproj%22%2C%22stack%22%3A%22dev%22%2C%22updateId%22%3A%22upd-1%22%7D`,
			);

			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ code: "invalid_ticket" });
		});
	});

	// ========================================================================
	// PulumiAccept enforcement
	// ========================================================================

	describe("PulumiAccept enforcement", () => {
		test("GET /api/user with valid auth but no Accept header remains backwards compatible", async () => {
			const app = makeApp();
			const res = await app.request("/api/user", {
				headers: { Authorization: "token valid-token" },
			});
			expect(res.status).toBe(200);
		});

		test("batch crypto requires the minimum Pulumi API version", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks/myorg/myproj/dev/batch-encrypt", {
				method: "POST",
				headers: {
					Authorization: "token valid-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ plaintexts: ["YQ=="] }),
			});
			expect(res.status).toBe(415);
		});

		test("batch crypto accepts newer Pulumi API versions", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks/myorg/myproj/dev/batch-encrypt", {
				method: "POST",
				headers: {
					Authorization: "token valid-token",
					Accept: "application/vnd.pulumi+9",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ plaintexts: ["YQ=="] }),
			});
			expect(res.status).toBe(200);
		});

		test("CLI token exchange remains compatible without Accept", async () => {
			const app = makeApp();
			const res = await app.request("/api/auth/cli-token", {
				method: "POST",
				headers: {
					Authorization: "token valid-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ name: "compatibility-test" }),
			});
			expect(res.status).toBe(200);
		});

		test("state export remains compatible without Accept", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks/myorg/myproj/dev/export", {
				headers: { Authorization: "token valid-token" },
			});
			expect(res.status).toBe(200);
		});

		test("delta checkpoints require the minimum Pulumi API version", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks/myorg/myproj/dev/update/upd-1/checkpointdelta", {
				method: "PATCH",
				headers: {
					Authorization:
						"update-token update:upd-1:sid-1:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(415);
		});

		test("delta checkpoints accept newer Pulumi API versions", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks/myorg/myproj/dev/update/upd-1/checkpointdelta", {
				method: "PATCH",
				headers: {
					Authorization:
						"update-token update:upd-1:sid-1:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
					Accept: "application/vnd.pulumi+9",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
		});
	});

	// ========================================================================
	// Authenticated API routes
	// ========================================================================

	describe("authenticated API routes", () => {
		test("POST /api/auth/cli-token rate limits the 11th request", async () => {
			const app = makeApp();
			const headers = {
				Authorization: "token valid-token",
				"Content-Type": "application/json",
				[INTERNAL_CLIENT_IP_HEADER]: "127.0.0.1",
			};

			for (let attempt = 1; attempt <= 10; attempt++) {
				const res = await app.request("/api/auth/cli-token", {
					method: "POST",
					headers,
					body: JSON.stringify({ name: `cli-${attempt}` }),
				});
				expect(res.status).toBe(200);
			}

			const limited = await app.request("/api/auth/cli-token", {
				method: "POST",
				headers,
				body: JSON.stringify({ name: "cli-11" }),
			});

			expect(limited.status).toBe(429);
			expect(await limited.json()).toEqual({ error: "Too many requests" });
		});

		test("single crypto requests keep lower rate limit than batch crypto requests", async () => {
			const app = makeApp();
			const headers = {
				...authHeaders,
				"Content-Type": "application/json",
				[INTERNAL_CLIENT_IP_HEADER]: "203.0.113.10",
			};

			for (let attempt = 1; attempt <= 1000; attempt++) {
				const res = await app.request("/api/stacks/myorg/myproj/dev/encrypt", {
					method: "POST",
					headers,
					body: JSON.stringify({ plaintext: "YQ==" }),
				});
				expect(res.status).toBe(200);
			}

			const limited = await app.request("/api/stacks/myorg/myproj/dev/encrypt", {
				method: "POST",
				headers,
				body: JSON.stringify({ plaintext: "YQ==" }),
			});
			expect(limited.status).toBe(429);

			const batch = await app.request("/api/stacks/myorg/myproj/dev/batch-encrypt", {
				method: "POST",
				headers,
				body: JSON.stringify({ plaintexts: ["YQ=="] }),
			});
			expect(batch.status).toBe(200);
		});

		test("GET /api/esc/environments returns CLI environment list shape", async () => {
			const app = makeApp();
			const res = await app.request("/api/esc/environments", { headers: authHeaders });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ environments: [], nextToken: "" });
		});

		test("GET /api/user returns user info with valid auth", async () => {
			const app = makeApp();
			const res = await app.request("/api/user", { headers: authHeaders });
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.githubLogin).toBe("test-user");
		});

		test("GET /api/stacks returns stack list", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks", { headers: authHeaders });
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.stacks).toBeArray();
		});

		test("POST /api/stacks/:org/:project/:stack creates a stack", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks/myorg/myproj/dev", {
				method: "POST",
				headers: { ...authHeaders, "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.orgName).toBe("my-org");
		});

		test("POST /api/stacks/:org/:project/:stack/:kind rejects invalid kind", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks/dev-org/proj/stack/badkind", {
				method: "POST",
				headers: {
					...authHeaders,
					Accept: "application/vnd.pulumi+8",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({}),
			});

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				code: "invalid_kind",
				message: "Invalid update kind: badkind",
			});
		});

		test("GET /api/stacks/:org/:project/:stack returns stack info", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks/myorg/myproj/dev", {
				headers: authHeaders,
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.stackName).toBe("dev");
		});

		test("DELETE /api/stacks/:org/:project/:stack returns 204", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks/myorg/myproj/dev", {
				method: "DELETE",
				headers: authHeaders,
			});
			expect(res.status).toBe(204);
		});
	});
});
