// @procella/server — createCliApp route parity + delta-checkpoint capability tests.

import { describe, expect, test } from "bun:test";
import type { AuditService } from "@procella/audit";
import type { AuthService } from "@procella/auth";
import type { Database } from "@procella/db";
import type { EscService } from "@procella/esc";
import type { StackInfo, StacksService } from "@procella/stacks";
import type { Caller } from "@procella/types";
import { UnauthorizedError } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import { type CliAppDeps, createCliApp } from "./cli.js";
import { createApp } from "./index.js";

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
		createWebhook: async () => {
			throw new Error("not exercised by CLI route parity tests");
		},
		listWebhooks: async () => [],
		getWebhook: async () => null,
		updateWebhook: async () => {
			throw new Error("not exercised by CLI route parity tests");
		},
		deleteWebhook: async () => {},
		listDeliveries: async () => [],
		emit: () => {},
		emitAndWait: async () => {},
		ping: async () => {
			throw new Error("not exercised by CLI route parity tests");
		},
	} as unknown as WebhooksService;
}

function mockEscService(): EscService {
	return {
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
	} as unknown as EscService;
}

function baseDeps(deltaCheckpointsEnabled?: boolean): CliAppDeps {
	return {
		auth: mockAuthService(),
		authConfig: {
			mode: "dev",
			token: "valid-token",
			userLogin: "test-user",
			orgLogin: "test-org",
		},
		audit: mockAuditService(),
		db: { execute: async () => ({ rows: [{ acquired: false }] }) } as unknown as Database,
		dbUrl: "postgres://test:test@localhost:5432/test",
		github: null,
		githubWebhookSecret: undefined,
		stacks: mockStacksService(),
		updates: mockUpdatesService(),
		webhooks: mockWebhooksService(),
		esc: mockEscService(),
		deltaCheckpointsEnabled,
	};
}

function makeCliApp(deltaCheckpointsEnabled?: boolean) {
	return createCliApp(baseDeps(deltaCheckpointsEnabled));
}

/** Matching createApp() instance used only for cross-assembler capability parity checks. */
function makeWebApp(deltaCheckpointsEnabled?: boolean) {
	return createApp({
		auth: mockAuthService(),
		authConfig: {
			mode: "dev",
			token: "valid-token",
			userLogin: "test-user",
			orgLogin: "test-org",
		},
		audit: mockAuditService(),
		db: { execute: async () => ({ rows: [{ acquired: false }] }) } as unknown as Database,
		dbUrl: "postgres://test:test@localhost:5432/test",
		github: null,
		githubWebhookSecret: undefined,
		stacks: mockStacksService(),
		updates: mockUpdatesService(),
		webhooks: mockWebhooksService(),
		esc: mockEscService(),
		deltaCheckpointsEnabled,
	});
}

// ============================================================================
// Tests
// ============================================================================

describe("@procella/server createCliApp", () => {
	test("GET /api/capabilities returns 200 without auth", async () => {
		const app = makeCliApp();
		const res = await app.request("/api/capabilities");
		expect(res.status).toBe(200);
	});

	describe("delta-checkpoint capability advertisement", () => {
		test("createApp and createCliApp return identical capability bodies when disabled (default)", async () => {
			const cliBody = await (await makeCliApp().request("/api/capabilities")).json();
			const webBody = await (await makeWebApp().request("/api/capabilities")).json();
			expect(cliBody).toEqual(webBody);
			expect(cliBody).toEqual({
				capabilities: [
					{ capability: "batch-encrypt" },
					{ capability: "deployment-schema-version", version: 1, configuration: { version: 3 } },
					{ capability: "journaling-v1", version: 1 },
				],
			});
		});

		test("createApp and createCliApp return identical capability bodies when enabled", async () => {
			const cliBody = await (await makeCliApp(true).request("/api/capabilities")).json();
			const webBody = await (await makeWebApp(true).request("/api/capabilities")).json();
			expect(cliBody).toEqual(webBody);
			expect(cliBody).toEqual({
				capabilities: [
					{ capability: "batch-encrypt" },
					{ capability: "deployment-schema-version", version: 1, configuration: { version: 3 } },
					{ capability: "journaling-v1", version: 1 },
					{
						capability: "delta-checkpoint-uploads-v2",
						version: 2,
						configuration: { checkpointCutoffSizeBytes: 1_048_576 },
					},
				],
			});
		});

		test("deltaCheckpointsEnabled=false is byte-equivalent to the pre-opt-in response", async () => {
			const offBody = await (await makeCliApp(false).request("/api/capabilities")).json();
			const defaultBody = await (await makeCliApp().request("/api/capabilities")).json();
			expect(offBody).toEqual(defaultBody);
		});
	});

	// ========================================================================
	// Route parity: only checkpointdelta/batch-encrypt/batch-decrypt remain
	// version-gated. No Accept requirement was added to any legacy route.
	// ========================================================================

	describe("route parity — pulumiAccept coverage is not widened", () => {
		const apiTokenAuth = { Authorization: "token valid-token" };
		const updateTokenAuth = {
			Authorization:
				"update-token update:upd-1:sid-1:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		};

		test("legacy routes remain non-415 without an Accept header", async () => {
			const app = makeCliApp();
			const legacyRequests: Array<[string, RequestInit]> = [
				["/api/capabilities", { method: "GET" }],
				["/api/cli/version", { method: "GET" }],
				["/api/user", { method: "GET", headers: apiTokenAuth }],
				["/api/user/stacks", { method: "GET", headers: apiTokenAuth }],
				["/api/stacks", { method: "GET", headers: apiTokenAuth }],
				[
					"/api/stacks/myorg/myproj",
					{
						method: "POST",
						headers: { ...apiTokenAuth, "Content-Type": "application/json" },
						body: "{}",
					},
				],
				["/api/stacks/myorg/myproj/dev", { method: "GET", headers: apiTokenAuth }],
				["/api/stacks/myorg/myproj/dev/export", { method: "GET", headers: apiTokenAuth }],
				[
					"/api/stacks/myorg/myproj/dev/import",
					{
						method: "POST",
						headers: { ...apiTokenAuth, "Content-Type": "application/json" },
						body: JSON.stringify({ version: 3, deployment: {} }),
					},
				],
				[
					"/api/stacks/myorg/myproj/dev/encrypt",
					{
						method: "POST",
						headers: { ...apiTokenAuth, "Content-Type": "application/json" },
						body: JSON.stringify({ plaintext: "YQ==" }),
					},
				],
				[
					"/api/stacks/myorg/myproj/dev/decrypt",
					{
						method: "POST",
						headers: { ...apiTokenAuth, "Content-Type": "application/json" },
						body: JSON.stringify({ ciphertext: "YQ==" }),
					},
				],
				[
					"/api/stacks/myorg/myproj/dev/update/upd-1",
					{
						method: "POST",
						headers: { ...apiTokenAuth, "Content-Type": "application/json" },
						body: "{}",
					},
				],
				["/api/stacks/myorg/myproj/dev/updates", { method: "GET", headers: apiTokenAuth }],
				[
					"/api/stacks/myorg/myproj/dev/update/upd-1/checkpoint",
					{
						method: "PATCH",
						headers: { ...updateTokenAuth, "Content-Type": "application/json" },
						body: "{}",
					},
				],
				[
					"/api/stacks/myorg/myproj/dev/update/upd-1/checkpointverbatim",
					{
						method: "PATCH",
						headers: { ...updateTokenAuth, "Content-Type": "application/json" },
						body: "{}",
					},
				],
				[
					"/api/stacks/myorg/myproj/dev/update/upd-1/events/batch",
					{
						method: "POST",
						headers: { ...updateTokenAuth, "Content-Type": "application/json" },
						body: JSON.stringify({ events: [] }),
					},
				],
				[
					"/api/stacks/myorg/myproj/dev/update/upd-1/complete",
					{
						method: "POST",
						headers: { ...updateTokenAuth, "Content-Type": "application/json" },
						body: JSON.stringify({ status: "succeeded" }),
					},
				],
			];

			for (const [path, init] of legacyRequests) {
				const res = await app.request(path, init);
				expect(
					res.status,
					`${init.method} ${path} must not be Accept-gated (got ${res.status})`,
				).not.toBe(415);
			}
		});

		test("exactly batch-encrypt, batch-decrypt, and checkpointdelta return 415 without Accept", async () => {
			const app = makeCliApp();
			const gatedRequests: Array<[string, RequestInit]> = [
				[
					"/api/stacks/myorg/myproj/dev/batch-encrypt",
					{
						method: "POST",
						headers: { ...apiTokenAuth, "Content-Type": "application/json" },
						body: JSON.stringify({ plaintexts: ["YQ=="] }),
					},
				],
				[
					"/api/stacks/myorg/myproj/dev/batch-decrypt",
					{
						method: "POST",
						headers: { ...apiTokenAuth, "Content-Type": "application/json" },
						body: JSON.stringify({ ciphertexts: ["YQ=="] }),
					},
				],
				[
					"/api/stacks/myorg/myproj/dev/update/upd-1/checkpointdelta",
					{
						method: "PATCH",
						headers: { ...updateTokenAuth, "Content-Type": "application/json" },
						body: "{}",
					},
				],
			];

			for (const [path, init] of gatedRequests) {
				const res = await app.request(path, init);
				expect(res.status, `${init.method} ${path} must be Accept-gated`).toBe(415);
			}
		});

		test("the three gated routes accept a modern Accept header", async () => {
			const app = makeCliApp();
			const withAccept = { Accept: "application/vnd.pulumi+9" };

			const batchEncryptRes = await app.request("/api/stacks/myorg/myproj/dev/batch-encrypt", {
				method: "POST",
				headers: { ...apiTokenAuth, ...withAccept, "Content-Type": "application/json" },
				body: JSON.stringify({ plaintexts: ["YQ=="] }),
			});
			expect(batchEncryptRes.status).toBe(200);

			const batchDecryptRes = await app.request("/api/stacks/myorg/myproj/dev/batch-decrypt", {
				method: "POST",
				headers: { ...apiTokenAuth, ...withAccept, "Content-Type": "application/json" },
				body: JSON.stringify({ ciphertexts: ["YQ=="] }),
			});
			expect(batchDecryptRes.status).toBe(200);

			const checkpointDeltaRes = await app.request(
				"/api/stacks/myorg/myproj/dev/update/upd-1/checkpointdelta",
				{
					method: "PATCH",
					headers: { ...updateTokenAuth, ...withAccept, "Content-Type": "application/json" },
					body: "{}",
				},
			);
			expect(checkpointDeltaRes.status).not.toBe(415);
		});
	});
});
