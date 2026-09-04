import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { loadConfig } from "@procella/config";
import { AesCryptoService } from "@procella/crypto";
import { checkpoints, createDb, type Database, type DbClient } from "@procella/db";
import type { EscService } from "@procella/esc";
import {
	PostgresStacksService,
	type StackInfo,
	type StacksService,
	validateName,
} from "@procella/stacks";
import {
	BadRequestError,
	type Caller,
	JournalEntryBegin,
	LeaseExpiredError,
} from "@procella/types";
import { ImportConflictError, PostgresUpdatesService } from "@procella/updates";
import { asc, eq } from "drizzle-orm";
import { requireExplicitEncryptionKey } from "../../apps/server/src/bootstrap.js";
import { createApp } from "../../apps/server/src/routes/index.js";
import { type JwksValidationError, JwksValidatorImpl } from "../../packages/oidc/src/jwks.js";
import { LocalBlobStorage } from "../../packages/storage/src/index.js";
import { GC_LEASE_GRACE_MS } from "../../packages/updates/src/types.js";
import {
	BACKEND_URL,
	TEST_DB_URL,
	TEST_ENCRYPTION_KEY,
	TEST_TOKEN,
	truncateTables,
} from "../helpers.js";

const ROUTES_SOURCE = new URL("../../apps/server/src/routes/index.ts", import.meta.url);
const STACKS_SOURCE = new URL("../../packages/stacks/src/index.ts", import.meta.url);
const UPDATES_SOURCE = new URL("../../packages/updates/src/postgres.ts", import.meta.url);

const authConfig = {
	mode: "dev" as const,
	token: TEST_TOKEN,
	userLogin: "test-user",
	orgLogin: "dev-org",
};

const validCaller: Caller = {
	tenantId: "tenant-regression",
	orgSlug: "dev-org",
	userId: "user-regression",
	login: "security-tester",
	roles: ["admin"],
	principalType: "user",
};

let db: Database;
let dbClient: DbClient;
let stacksService: PostgresStacksService;
let updatesService: PostgresUpdatesService;
let blobDir: string;

async function connectDbWithRetry(retries = 10): Promise<{ db: Database; client: DbClient }> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			return await createDb({ url: TEST_DB_URL });
		} catch (error) {
			lastError = error;
			if (attempt < retries) {
				await Bun.sleep(250 * attempt);
			}
		}
	}
	throw lastError;
}

function setProcellaEnv(values: Record<string, string | undefined>): () => void {
	const keys = new Set<string>([...Object.keys(values), "PORT"]);
	const previous = new Map<string, string | undefined>();
	for (const key of keys) {
		previous.set(key, process.env[key]);
	}
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	return () => {
		for (const key of keys) {
			const prior = previous.get(key);
			if (prior === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = prior;
			}
		}
	};
}

function createSizedPayload(bytes: number): string {
	const chunkSize = 256 * 1024;
	const chunks: string[] = [];
	let payload = JSON.stringify({ data: chunks });

	while (Buffer.byteLength(payload) < bytes) {
		const remaining = bytes - Buffer.byteLength(payload);
		const nextChunkSize = Math.min(chunkSize, Math.max(1, remaining));
		chunks.push("x".repeat(nextChunkSize));
		payload = JSON.stringify({ data: chunks });
	}

	return payload;
}

function makeRouteTestApp(opts?: { corsOrigins?: string[]; cronSecret?: string }) {
	const mockDb = {
		execute: async () => [{ "?column?": 1 }],
	} as unknown as Database;

	const mockStackInfo: StackInfo = {
		id: "stack-1",
		projectId: "project-1",
		tenantId: validCaller.tenantId,
		orgName: validCaller.orgSlug,
		projectName: "project-1",
		stackName: "stack-1",
		tags: {},
		activeUpdateId: null,
		lastUpdate: null,
		resourceCount: null,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	};

	const mockStacks = {
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
	} satisfies StacksService;

	return createApp({
		auth: {
			authenticate: async () => validCaller,
			createCliAccessKey: async () => "cli-token",
			authenticateUpdateToken: async () => ({ updateId: "update-1", stackId: mockStackInfo.id }),
		},
		authConfig,
		audit: {
			log: () => {},
			query: async () => ({ entries: [], total: 0 }),
			export: async () => [],
		},
		corsOrigins: opts?.corsOrigins,
		cronSecret: opts?.cronSecret,
		db: mockDb,
		dbUrl: TEST_DB_URL,
		stacks: mockStacks,
		updates: {
			createUpdate: async () => ({ updateID: "update-1" }),
			startUpdate: async () => ({
				version: 1,
				token: "update:update-1:stack-1:secret",
				tokenExpiration: Math.floor(Date.now() / 1000) + 300,
			}),
			completeUpdate: async () => {},
			cancelUpdate: async () => {},
			patchCheckpoint: async () => {},
			patchCheckpointVerbatim: async () => {},
			patchCheckpointDelta: async () => {},
			appendJournalEntries: async () => {},
			postEvents: async () => {},
			renewLease: async () => ({
				token: "update:update-1:stack-1:secret",
				tokenExpiration: Math.floor(Date.now() / 1000) + 300,
			}),
			getUpdate: async () => ({ status: "succeeded", events: [], startTime: Date.now() }),
			getUpdateEvents: async () => ({ events: [] }),
			getHistory: async () => ({ updates: [] }),
			exportStack: async () => ({ version: 3, deployment: {} }),
			importStack: async () => ({ updateId: "import-1" }),
			encryptValue: async () => new Uint8Array([1]),
			decryptValue: async () => new Uint8Array([1]),
			batchEncrypt: async () => [new Uint8Array([1])],
			batchDecrypt: async () => [new Uint8Array([1])],
			verifyLeaseToken: async () => {},
			verifyUpdateOwnership: async () => {},
		},
		webhooks: {
			createWebhook: async () => ({
				id: "hook-1",
				name: "hook",
				url: "https://example.com/hook",
				events: ["stack.created"],
				active: true,
				createdBy: validCaller.userId,
				createdAt: new Date("2026-01-01T00:00:00Z"),
				updatedAt: new Date("2026-01-01T00:00:00Z"),
				secret: "secret",
			}),
			listWebhooks: async () => [],
			getWebhook: async () => null,
			updateWebhook: async (_tenantId, webhookId) => ({
				id: webhookId,
				name: "hook",
				url: "https://example.com/hook",
				events: ["stack.created"],
				active: true,
				createdBy: validCaller.userId,
				createdAt: new Date("2026-01-01T00:00:00Z"),
				updatedAt: new Date("2026-01-01T00:00:00Z"),
			}),
			deleteWebhook: async () => {},
			listDeliveries: async () => [],
			emit: () => {},
			emitAndWait: async () => {},
			ping: async () => ({
				id: "delivery-1",
				event: "webhook.ping",
				responseStatus: 200,
				success: true,
				attempt: 1,
				error: null,
				duration: 10,
				createdAt: new Date("2026-01-01T00:00:00Z"),
			}),
		},
		esc: {} as unknown as EscService,
		github: null,
		githubWebhookSecret: undefined,
	});
}

async function seedStack(tenantId = validCaller.tenantId): Promise<StackInfo> {
	return stacksService.createStack(
		tenantId,
		tenantId,
		`project-${Date.now()}`,
		`stack-${Date.now()}`,
	);
}

describe("[security] MEDIUM regressions (vulns.txt M1-M15)", () => {
	beforeAll(async () => {
		const dbResult = await connectDbWithRetry();
		db = dbResult.db;
		dbClient = dbResult.client;
		blobDir = await mkdtemp(path.join(tmpdir(), "procella-medium-regressions-"));
		stacksService = new PostgresStacksService({ db });
		updatesService = new PostgresUpdatesService({
			db,
			storage: new LocalBlobStorage(blobDir),
			crypto: new AesCryptoService(TEST_ENCRYPTION_KEY),
		});
	});

	afterEach(async () => {
		await truncateTables();
	});

	afterAll(async () => {
		await dbClient.close();
		await rm(blobDir, { recursive: true, force: true });
	});

	test("[M1] createStack rejects org name with slash/control-chars", async () => {
		// Exploit attempt (vulns.txt M1): smuggle path separators/control bytes into createStack identifiers.
		// Regression guard mirrors packages/stacks/src/stacks.test.ts: validateName() is the createStack gate.
		expect(() => validateName("org/evil", "org")).toThrow();
		expect(() => validateName("org\u0000evil", "org")).toThrow();
	});

	test("[M2] crypto refuses to start without master key", () => {
		// Exploit attempt (vulns.txt M2): boot with no explicit master key and fall back to a known default.
		// Regression mirrors apps/server/src/bootstrap.test.ts.
		expect(() => requireExplicitEncryptionKey(undefined)).toThrow(
			/PROCELLA_ENCRYPTION_KEY is required/,
		);
	});

	test("[M3] config requires explicit PROCELLA_AUTH_MODE (no dev default)", () => {
		// Exploit attempt (vulns.txt M3): omit PROCELLA_AUTH_MODE and silently land in dev auth.
		// Regression mirrors packages/config/src/config.test.ts by loading config with authMode omitted.
		const restore = setProcellaEnv({
			PROCELLA_DATABASE_URL: TEST_DB_URL,
			PROCELLA_AUTH_MODE: undefined,
			PROCELLA_DEV_AUTH_TOKEN: TEST_TOKEN,
			PROCELLA_TICKET_SIGNING_KEY: "ticket-signing-key-ticket-signing-key",
			PROCELLA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
		});
		try {
			expect(() => loadConfig()).toThrow();
		} finally {
			restore();
		}
	});

	test("[M3b] /cron/gc rejects without secret even in NODE_ENV=test", async () => {
		// Exploit attempt (vulns.txt M3b): hit /cron/gc in test/dev and rely on a secret-check bypass.
		// Regression mirrors integration/cron.integration.test.ts.
		const previousNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "test";
		try {
			const res = await makeRouteTestApp({ cronSecret: undefined }).request("/cron/gc");
			expect(res.status).toBe(401);
		} finally {
			process.env.NODE_ENV = previousNodeEnv;
		}
	});

	test("[M3c] cron secret comparison uses timingSafeEqual", async () => {
		// Exploit attempt (vulns.txt M3c): brute-force cron secret with length-matched timing oracle.
		// Regression is structural: safeEqualString in routes uses timingSafeEqual with equal-length buffers.
		const source = await Bun.file(ROUTES_SOURCE).text();
		expect(source).toContain("function safeEqualString");
		expect(source).toContain("timingSafeEqual(aBuf, bBuf)");
		expect(source).toContain("if (aBuf.length !== bBuf.length)");
	});

	test("[M4] CORS without explicit allowlist refuses to mount", async () => {
		// Exploit attempt (vulns.txt M4): send an arbitrary Origin and rely on permissive default CORS reflection.
		// Regression mirrors apps/server/src/routes/routes.test.ts.
		const res = await makeRouteTestApp({ corsOrigins: [] }).request("/healthz", {
			headers: { Origin: "https://evil.example" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	test("[M5] getOrganization returns 404 when URL orgName != caller.orgSlug", async () => {
		// Exploit attempt (vulns.txt M5): spoof another org in the URL so the UI echoes a forged organization.
		// Regression mirrors apps/server/src/handlers/handlers.test.ts against the running e2e server.
		const res = await fetch(`${BACKEND_URL}/api/user/organizations/other-org`, {
			headers: {
				Authorization: `token ${TEST_TOKEN}`,
				Accept: "application/vnd.pulumi+8",
			},
		});
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: 404, message: "not found" });
	});

	test("[M6] getStackByNames_systemOnly is the only callable variant (renamed)", async () => {
		// Exploit attempt (vulns.txt M6): call an unscoped stack lookup helper from non-system code.
		// Regression mirrors packages/stacks/src/stacks.test.ts by asserting only the renamed system-only API remains.
		const source = await Bun.file(STACKS_SOURCE).text();
		expect(source).toContain("getStackByNames_systemOnly(");
		expect(source).not.toMatch(/\bgetStackByNames\s*\(/);
	});

	test("[M7] patchCheckpoint rejects writes after cancelUpdate (TX re-assert)", async () => {
		// Exploit attempt (vulns.txt M7): cancel an update, then race a late checkpoint write into the dead update.
		// Regression mirrors integration/updates.integration.test.ts using the real Postgres service.
		const stack = await seedStack();
		const created = await updatesService.createUpdate(stack.id, "update");
		await updatesService.startUpdate(created.updateID, {});
		await updatesService.cancelUpdate(created.updateID);

		return expect(
			updatesService.patchCheckpoint(created.updateID, {
				isInvalid: false,
				version: 3,
				deployment: { resources: [] },
			}),
		).rejects.toBeInstanceOf(LeaseExpiredError);
	});

	test("[M8] GC worker preserves leases within 30s grace window", () => {
		// Exploit attempt (vulns.txt M8): let GC yank an executor lease immediately at expiry and corrupt ordering.
		// Regression mirrors packages/updates/src/gc-worker.test.ts.
		expect(GC_LEASE_GRACE_MS).toBe(30_000);
	});

	test("[M9] renewLease caps duration at 300 seconds", async () => {
		// Exploit attempt (vulns.txt M9): renew a lease for an arbitrarily long duration and pin the stack forever.
		// Regression mirrors integration/updates.integration.test.ts and packages/updates/src/helpers.test.ts.
		const stack = await seedStack();
		const created = await updatesService.createUpdate(stack.id, "update");
		const started = await updatesService.startUpdate(created.updateID, {});
		if (!started.token) {
			throw new Error("lease token missing from startUpdate response");
		}

		const before = Math.floor(Date.now() / 1000);
		const renewed = await updatesService.renewLease(created.updateID, {
			token: started.token,
			duration: 99_999,
		});

		expect(renewed.token).toBe(started.token);
		expect(renewed.tokenExpiration).toBeLessThanOrEqual(before + 301);
		expect(renewed.tokenExpiration).toBeGreaterThanOrEqual(before + 299);
	});

	test("[M10] importStack rejects when stack has active update", async () => {
		// Exploit attempt (vulns.txt M10): bypass the single-active-update invariant by importing while another update runs.
		// Regression mirrors integration/updates.integration.test.ts.
		const stack = await seedStack();
		const created = await updatesService.createUpdate(stack.id, "update");
		await updatesService.startUpdate(created.updateID, {});

		return expect(
			updatesService.importStack(stack.id, { version: 3, deployment: { resources: [] } }),
		).rejects.toBeInstanceOf(ImportConflictError);
	});

	test("[M11] decompress middleware rejects bodies > 32 MiB on /api/* default", async () => {
		// Exploit attempt (vulns.txt M11): send a gzip bomb to a normal /api/* route and exhaust process memory.
		// Regression mirrors apps/server/src/middleware/decompress.test.ts against the running e2e server.
		const compressed = gzipSync(Buffer.from(createSizedPayload(33 * 1024 * 1024)));
		const res = await fetch(`${BACKEND_URL}/api/auth/cli-token`, {
			method: "POST",
			headers: {
				Authorization: `token ${TEST_TOKEN}`,
				Accept: "application/vnd.pulumi+8",
				"Content-Type": "application/json",
				"Content-Encoding": "gzip",
			},
			body: compressed,
		});
		expect(res.status).toBe(413);
	});

	test("[M12] OIDC discovery rejects private-IP issuer", async () => {
		// Exploit attempt (vulns.txt M12): point OIDC discovery at a private IP / metadata address and SSRF the server.
		// Regression mirrors packages/oidc/src/jwks.test.ts.
		const validator = new JwksValidatorImpl({ allowHttp: false });
		return expect(
			validator.verify("a.b.c", "https://10.0.0.1", "procella-audience"),
		).rejects.toMatchObject({ code: "ssrf_blocked" } satisfies Partial<JwksValidationError>);
	});

	test("[M13] appendJournalEntries rejects > 10000 entries", async () => {
		// Exploit attempt (vulns.txt M13): append an enormous journal batch to waste CPU and memory in BigInt parsing.
		// Regression mirrors integration/updates.integration.test.ts and packages/updates/src/helpers.test.ts.
		const stack = await seedStack();
		const created = await updatesService.createUpdate(stack.id, "update");
		await updatesService.startUpdate(created.updateID, {});

		return expect(
			updatesService.appendJournalEntries(created.updateID, {
				entries: Array.from({ length: 10_001 }, (_, index) => ({
					version: 1,
					kind: JournalEntryBegin,
					operationID: index + 1,
					sequenceID: index + 1,
				})),
			}),
		).rejects.toBeInstanceOf(BadRequestError);
	});

	test("[M14] updateStackTags is atomic (no read-modify-write race)", async () => {
		// Exploit attempt (vulns.txt M14): concurrent tag PATCHes lose one writer through out-of-transaction RMW logic.
		// Regression is structural: updateStackTags now wraps read + merge + write inside one transaction block.
		const source = await Bun.file(STACKS_SOURCE).text();
		const updateStackTagsBlock = source.match(
			/async updateStackTags\([\s\S]*?\n\tasync replaceStackTags/,
		);
		expect(updateStackTagsBlock).not.toBeNull();
		expect(updateStackTagsBlock?.[0]).toContain("this.db.transaction(async (tx) => {");
		expect(updateStackTagsBlock?.[0]).toContain(
			"mergeTags((rows[0].stackTags ?? {}) as Record<string, string>, tags)",
		);
	});

	test("[M15] checkpoint version cache no longer exists; SELECT MAX(version) FOR UPDATE is used", async () => {
		// Exploit attempt (vulns.txt M15): rely on a process-local checkpoint version cache so replicas overwrite newer checkpoints.
		// Regression combines structural proof (no cache, row locking) with the integration assertion from updates.integration.test.ts.
		const source = await Bun.file(UPDATES_SOURCE).text();
		expect(source).not.toContain("checkpointVersionCache");
		expect(source).toContain(
			'SELECT stack_id AS "stackId", status, lease_token AS "leaseToken", lease_expires_at AS "leaseExpiresAt"',
		);
		expect(source).toContain("FOR UPDATE");
		expect(source).toContain('SELECT COALESCE(MAX(version), 0) + 1 AS "nextVersion"');

		const stack = await seedStack();
		const created = await updatesService.createUpdate(stack.id, "update");
		await updatesService.startUpdate(created.updateID, {});

		const firstDeployment = {
			manifest: { time: new Date().toISOString(), magic: "", version: "" },
			resources: [{ urn: "urn:pulumi:stack::proj::test:index:Thing::one", custom: true }],
		};
		const secondDeployment = {
			manifest: { time: new Date().toISOString(), magic: "", version: "" },
			resources: [{ urn: "urn:pulumi:stack::proj::test:index:Thing::two", custom: true }],
		};

		const results = await Promise.allSettled([
			updatesService.patchCheckpoint(created.updateID, {
				isInvalid: false,
				version: 3,
				deployment: firstDeployment,
			}),
			updatesService.patchCheckpoint(created.updateID, {
				isInvalid: false,
				version: 3,
				deployment: secondDeployment,
			}),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);

		const persisted = await db
			.select({ version: checkpoints.version })
			.from(checkpoints)
			.where(eq(checkpoints.updateId, created.updateID))
			.orderBy(asc(checkpoints.version));

		expect(persisted.map((row) => row.version)).toEqual([1, 2]);
	});
});
