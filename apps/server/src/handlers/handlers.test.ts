import { describe, expect, mock, test } from "bun:test";
import { LATEST_MIGRATION_TIMESTAMP } from "@procella/db";
import type { StackInfo, StacksService } from "@procella/stacks";
import type { Caller, CapabilitiesResponse } from "@procella/types";
import { BadRequestError } from "@procella/types";
import { BLOB_THRESHOLD } from "@procella/updates";
import type { SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { healthHandlers } from "./health.js";
import { param, updateContext } from "./params.js";
import { stackHandlers } from "./stacks.js";
import { userHandlers } from "./user.js";

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
	tags: { env: "dev" },
	activeUpdateId: null,
	lastUpdate: null,
	resourceCount: null,
	createdAt: new Date("2025-01-01"),
	updatedAt: new Date("2025-01-01"),
};

// ============================================================================
// Mock Services
// ============================================================================

function mockStacksService(overrides?: Partial<StacksService>): StacksService {
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
		...overrides,
	};
}

/** Middleware that injects a mock caller into context. */
function injectCaller(caller: Caller) {
	return async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
		c.set("caller", caller);
		await next();
	};
}

// ============================================================================
// Upstream-equivalent CapabilitiesResponse parser (test-only contract)
//
// Mirrors apitype.CapabilitiesResponse.Parse() semantics from the Pulumi Go
// SDK (v3.265): iterate capability entries, decode each known capability's
// configuration into its typed field, and ignore unknown capabilities
// (forward-compatible). A malformed configuration for a *known* capability
// is treated as a hard parse failure — upstream discards the whole parsed
// set rather than partially applying it.
// ============================================================================

interface ParsedCapabilities {
	BatchEncryption: boolean;
	DeploymentSchemaVersion: number;
	StackOutputs: boolean;
	DeltaCheckpointUpdates?: { checkpointCutoffSizeBytes: number };
}

function parseCapabilitiesResponseUpstreamEquivalent(
	response: CapabilitiesResponse,
): ParsedCapabilities {
	const result: ParsedCapabilities = {
		BatchEncryption: false,
		DeploymentSchemaVersion: 0,
		StackOutputs: false,
	};
	for (const entry of response.capabilities) {
		switch (entry.capability) {
			case "batch-encrypt":
				result.BatchEncryption = true;
				break;
			case "deployment-schema-version": {
				const cfg = entry.configuration as { version?: number } | undefined;
				if (typeof cfg?.version !== "number") {
					throw new Error("malformed deployment-schema-version configuration");
				}
				result.DeploymentSchemaVersion = cfg.version;
				break;
			}
			case "stack-outputs":
				result.StackOutputs = entry.version === 1;
				break;
			case "delta-checkpoint-uploads-v2": {
				const cfg = entry.configuration as { checkpointCutoffSizeBytes?: number } | undefined;
				if (typeof cfg?.checkpointCutoffSizeBytes !== "number") {
					throw new Error("malformed delta-checkpoint-uploads-v2 configuration");
				}
				result.DeltaCheckpointUpdates = {
					checkpointCutoffSizeBytes: cfg.checkpointCutoffSizeBytes,
				};
				break;
			}
			default:
				// Unknown/local-extension capabilities (e.g. journaling-v1) are
				// intentionally ignored, matching upstream forward-compatibility.
				break;
		}
	}
	return result;
}

// ============================================================================
// Tests
// ============================================================================

describe("@procella/server handlers", () => {
	// ========================================================================
	// healthHandlers
	// ========================================================================

	describe("healthHandlers", () => {
		const MIGRATED_ROW = {
			relation_0: "projects",
			relation_1: "stacks",
			relation_2: "updates",
			relation_3: "checkpoints",
			relation_4: "__drizzle_migrations",
			migrated: true,
		};
		const mockDb = { execute: async () => [MIGRATED_ROW] } as never;

		test("health returns { status: ok } when the schema is current", async () => {
			const app = new Hono<Env>();
			const health = healthHandlers({ db: mockDb });
			app.get("/healthz", health.health);

			const res = await app.request("/healthz");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ status: "ok" });
		});

		test("health probes required relations and the latest migration marker", async () => {
			const execute = mock(async (_query: unknown) => [MIGRATED_ROW]);
			const app = new Hono<Env>();
			app.get("/healthz", healthHandlers({ db: { execute } as never }).health);

			await app.request("/healthz");

			const dialect = new PgDialect();
			const relationQuery = execute.mock.calls[0]?.[0] as SQLWrapper;
			const relationSql = dialect.sqlToQuery(relationQuery.getSQL()).sql;
			for (const relation of [
				"public.projects",
				"public.stacks",
				"public.updates",
				"public.checkpoints",
				"drizzle.__drizzle_migrations",
			]) {
				expect(relationSql).toContain(`to_regclass('${relation}')`);
			}

			const migrationQuery = execute.mock.calls[1]?.[0] as SQLWrapper;
			const migration = dialect.sqlToQuery(migrationQuery.getSQL());
			expect(migration.sql).toContain('FROM "drizzle"."__drizzle_migrations"');
			expect(migration.params).toEqual([LATEST_MIGRATION_TIMESTAMP]);
		});

		test("health reads the neon driver's { rows } result shape", async () => {
			const neonDb = { execute: async () => ({ rows: [MIGRATED_ROW] }) } as never;
			const app = new Hono<Env>();
			app.get("/healthz", healthHandlers({ db: neonDb }).health);

			const res = await app.request("/healthz");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ status: "ok" });
		});

		test("health returns 503 when any required relation is missing", async () => {
			for (const missing of Object.keys(MIGRATED_ROW).filter((key) =>
				key.startsWith("relation_"),
			)) {
				const unmigratedDb = {
					execute: async () => [{ ...MIGRATED_ROW, [missing]: null }],
				} as never;
				const app = new Hono<Env>();
				app.get("/healthz", healthHandlers({ db: unmigratedDb }).health);

				const res = await app.request("/healthz");
				expect(res.status).toBe(503);
				expect(await res.json()).toEqual({
					status: "error",
					message: "database schema not migrated",
				});
			}
		});

		test("health returns 503 when the database returns no readiness row", async () => {
			const emptyDb = { execute: async () => [] } as never;
			const app = new Hono<Env>();
			app.get("/healthz", healthHandlers({ db: emptyDb }).health);

			const res = await app.request("/healthz");
			expect(res.status).toBe(503);
			expect((await res.json()).message).toBe("database schema not migrated");
		});

		test("health returns 503 when the latest migration is missing", async () => {
			let call = 0;
			const staleDb = {
				execute: async () => (call++ === 0 ? [MIGRATED_ROW] : [{ migrated: false }]),
			} as never;
			const app = new Hono<Env>();
			app.get("/healthz", healthHandlers({ db: staleDb }).health);

			const res = await app.request("/healthz");
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({
				status: "error",
				message: "database schema not migrated",
			});
		});

		test("health returns 503 when db is unreachable", async () => {
			const failDb = {
				execute: async () => {
					throw new Error("connection refused");
				},
			} as never;
			const app = new Hono<Env>();
			const health = healthHandlers({ db: failDb });
			app.get("/healthz", health.health);

			const res = await app.request("/healthz");
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({
				status: "error",
				message: "database unreachable",
			});
		});

		test("capabilities returns the exact expected wire shape when delta checkpoints are disabled (default)", async () => {
			const app = new Hono<Env>();
			const health = healthHandlers({ db: mockDb });
			app.get("/capabilities", health.capabilities);

			const res = await app.request("/capabilities");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({
				capabilities: [
					{ capability: "batch-encrypt" },
					{ capability: "deployment-schema-version", version: 1, configuration: { version: 3 } },
					{ capability: "stack-outputs", version: 1 },
					{ capability: "journaling-v1", version: 1 },
				],
			});
		});

		test("capabilities is byte/shape-equivalent when deltaCheckpointsEnabled is explicitly false", async () => {
			const app = new Hono<Env>();
			const health = healthHandlers({ db: mockDb, deltaCheckpointsEnabled: false });
			app.get("/capabilities", health.capabilities);

			const res = await app.request("/capabilities");
			const body = await res.json();
			expect(body).toEqual({
				capabilities: [
					{ capability: "batch-encrypt" },
					{ capability: "deployment-schema-version", version: 1, configuration: { version: 3 } },
					{ capability: "stack-outputs", version: 1 },
					{ capability: "journaling-v1", version: 1 },
				],
			});
		});

		test("capabilities appends exactly the delta-checkpoint-uploads-v2 entry when enabled", async () => {
			const app = new Hono<Env>();
			const health = healthHandlers({ db: mockDb, deltaCheckpointsEnabled: true });
			app.get("/capabilities", health.capabilities);

			const res = await app.request("/capabilities");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({
				capabilities: [
					{ capability: "batch-encrypt" },
					{ capability: "deployment-schema-version", version: 1, configuration: { version: 3 } },
					{ capability: "stack-outputs", version: 1 },
					{ capability: "journaling-v1", version: 1 },
					{
						capability: "delta-checkpoint-uploads-v2",
						version: 2,
						configuration: { checkpointCutoffSizeBytes: 1_048_576 },
					},
				],
			});
			// Cutoff must be derived from BLOB_THRESHOLD, not a duplicated magic number.
			expect(body.capabilities[4].configuration.checkpointCutoffSizeBytes).toBe(BLOB_THRESHOLD);
		});

		test("upstream-equivalent parser recognizes stack outputs in the default response", async () => {
			const app = new Hono<Env>();
			const health = healthHandlers({ db: mockDb, deltaCheckpointsEnabled: false });
			app.get("/capabilities", health.capabilities);
			const body = (await (await app.request("/capabilities")).json()) as CapabilitiesResponse;

			const parsed = parseCapabilitiesResponseUpstreamEquivalent(body);
			expect(parsed.BatchEncryption).toBe(true);
			expect(parsed.DeploymentSchemaVersion).toBe(3);
			expect(parsed.StackOutputs).toBe(true);
			expect(parsed.DeltaCheckpointUpdates).toBeUndefined();
		});

		test("upstream-equivalent parser: enabled response parses DeltaCheckpointUpdates cutoff from BLOB_THRESHOLD", async () => {
			const app = new Hono<Env>();
			const health = healthHandlers({ db: mockDb, deltaCheckpointsEnabled: true });
			app.get("/capabilities", health.capabilities);
			const body = (await (await app.request("/capabilities")).json()) as CapabilitiesResponse;

			const parsed = parseCapabilitiesResponseUpstreamEquivalent(body);
			expect(parsed.BatchEncryption).toBe(true);
			expect(parsed.DeploymentSchemaVersion).toBe(3);
			expect(parsed.StackOutputs).toBe(true);
			expect(parsed.DeltaCheckpointUpdates).toEqual({ checkpointCutoffSizeBytes: BLOB_THRESHOLD });
		});

		test("upstream-equivalent parser: one malformed capability entry zeros the entire parsed set (fail-closed)", () => {
			const malformed: CapabilitiesResponse = {
				capabilities: [
					{ capability: "batch-encrypt" },
					// Missing required `configuration.version` — malformed per upstream Parse().
					{ capability: "deployment-schema-version", version: 1 },
				],
			};

			// Upstream apitype.CapabilitiesResponse.Parse() returns an error on a
			// malformed known-capability entry; callers treat that as zero parsed
			// capabilities rather than partially applying the well-formed ones.
			expect(() => parseCapabilitiesResponseUpstreamEquivalent(malformed)).toThrow(
				/malformed deployment-schema-version configuration/,
			);
		});

		test("cliVersion returns version info", async () => {
			const app = new Hono<Env>();
			const health = healthHandlers({ db: mockDb });
			app.get("/version", health.cliVersion);

			const res = await app.request("/version");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toHaveProperty("latestVersion");
			expect(body).toHaveProperty("oldestWithoutWarning");
			expect(body).toHaveProperty("latestDevVersion");
		});
	});

	// ========================================================================
	// param() helper
	// ========================================================================

	describe("param()", () => {
		test("returns param value when present", async () => {
			const app = new Hono<Env>();
			app.get("/test/:id", (c) => {
				const id = param(c, "id");
				return c.json({ id });
			});

			const res = await app.request("/test/abc");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.id).toBe("abc");
		});

		test("throws BadRequestError when param is missing", () => {
			// param() is a pure function that reads from context
			// Test by calling with a mock context that has no params
			const mockContext = {
				req: {
					param: (_name: string) => undefined,
				},
			};
			expect(() => param(mockContext as never, "missing")).toThrow(BadRequestError);
		});
	});

	// ========================================================================
	// updateContext() helper
	// ========================================================================

	describe("updateContext()", () => {
		test("returns updateContext when set", async () => {
			const app = new Hono<Env>();
			app.use("*", async (c, next) => {
				c.set("updateContext", { updateId: "u-1", stackId: "s-1" });
				await next();
			});
			app.get("/test", (c) => {
				const ctx = updateContext(c);
				return c.json(ctx);
			});

			const res = await app.request("/test");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.updateId).toBe("u-1");
			expect(body.stackId).toBe("s-1");
		});

		test("throws BadRequestError when updateContext is not set", () => {
			const mockContext = {
				get: (_key: string) => undefined,
			};
			expect(() => updateContext(mockContext as never)).toThrow(BadRequestError);
		});
	});

	// ========================================================================
	// userHandlers
	// ========================================================================

	describe("userHandlers", () => {
		test("getCurrentUser returns user info from caller", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const user = userHandlers(mockStacksService());
			app.get("/user", user.getCurrentUser);

			const res = await app.request("/user");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.githubLogin).toBe("test-user");
			expect(body.name).toBe("test-user");
			expect(body.organizations).toBeArray();
			expect(body.organizations[0].githubLogin).toBe("my-org");
		});

		test("getUserStacks returns stacks for caller tenant", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const user = userHandlers(mockStacksService());
			app.get("/stacks", user.getUserStacks);

			const res = await app.request("/stacks");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.stacks).toBeArray();
			expect(body.stacks).toHaveLength(1);
		});
	});

	// ========================================================================
	// stackHandlers
	// ========================================================================

	describe("stackHandlers", () => {
		test("createStack returns mapped Stack shape", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const stackH = stackHandlers(mockStacksService());
			app.post("/stacks/:org/:project/:stack", stackH.createStack);

			const res = await app.request("/stacks/myorg/myproj/dev", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.orgName).toBe("my-org");
			expect(body.projectName).toBe("myproj");
			expect(body.stackName).toBe("dev");
			expect(body).toHaveProperty("id");
		});

		test("getStack returns mapped Stack shape", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const stackH = stackHandlers(mockStacksService());
			app.get("/stacks/:org/:project/:stack", stackH.getStack);

			const res = await app.request("/stacks/myorg/myproj/dev");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.orgName).toBe("my-org");
			expect(body.stackName).toBe("dev");
		});

		test("deleteStack forwards force and returns 204", async () => {
			const forceValues: Array<boolean | undefined> = [];
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const stackH = stackHandlers(
				mockStacksService({
					deleteStack: async (_tenantId, _org, _project, _stack, force) => {
						forceValues.push(force);
					},
				}),
			);
			app.delete("/stacks/:org/:project/:stack", stackH.deleteStack);

			const guarded = await app.request("/stacks/myorg/myproj/dev", {
				method: "DELETE",
			});
			expect(guarded.status).toBe(204);

			const forced = await app.request("/stacks/myorg/myproj/dev?force=true", {
				method: "DELETE",
			});
			expect(forced.status).toBe(204);
			expect(forceValues).toEqual([false, true]);
		});

		test("listStacks returns array of stacks", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const stackH = stackHandlers(mockStacksService());
			app.get("/stacks", stackH.listStacks);

			const res = await app.request("/stacks");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.stacks).toBeArray();
			expect(body.stacks).toHaveLength(1);
		});

		test("renameStack returns 204", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const stackH = stackHandlers(mockStacksService());
			app.post("/stacks/:org/:project/:stack/rename", stackH.renameStack);

			const res = await app.request("/stacks/myorg/myproj/dev/rename", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ newName: "staging" }),
			});
			expect(res.status).toBe(204);
		});

		test("updateStackTags returns 204", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const stackH = stackHandlers(mockStacksService());
			app.patch("/stacks/:org/:project/:stack/tags", stackH.updateStackTags);

			const res = await app.request("/stacks/myorg/myproj/dev/tags", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ env: "staging", team: "platform" }),
			});
			expect(res.status).toBe(204);
		});
	});

	// ========================================================================
	// userHandlers — additional
	// ========================================================================

	describe("userHandlers — getOrganization", () => {
		test("getOrganization returns org info when URL matches caller.orgSlug", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const user = userHandlers(mockStacksService());
			app.get("/user/organizations/:orgName", user.getOrganization);

			const res = await app.request("/user/organizations/my-org");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.githubLogin).toBe("my-org");
			expect(body.name).toBe("my-org");
			expect(body.defaultTeam).toBeDefined();
			expect(body.defaultTeam.name).toBe("my-org");
		});

		test("getOrganization('default') returns caller's orgSlug", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const user = userHandlers(mockStacksService());
			app.get("/user/organizations/:orgName", user.getOrganization);

			const res = await app.request("/user/organizations/default");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.githubLogin).toBe(validCaller.orgSlug);
			expect(body.name).toBeUndefined();
		});

		test("M5: getOrganization returns 404 when URL orgName != caller.orgSlug", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const user = userHandlers(mockStacksService());
			app.get("/user/organizations/:orgName", user.getOrganization);

			const res = await app.request("/user/organizations/other-org");
			expect(res.status).toBe(404);
			const body = await res.json();
			expect(body.code).toBe(404);
		});

		test("M5: getOrganization uses caller.orgSlug (not URL) in response", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const user = userHandlers(mockStacksService());
			app.get("/user/organizations/:orgName", user.getOrganization);

			const res = await app.request("/user/organizations/my-org");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.githubLogin).toBe(validCaller.orgSlug);
			expect(body.name).toBe(validCaller.orgSlug);
			expect(body.defaultTeam.name).toBe(validCaller.orgSlug);
		});
	});

	// ========================================================================
	// stackHandlers — searchStacks path
	// ========================================================================

	describe("stackHandlers — search", () => {
		test("listStacks uses searchStacks when query params present", async () => {
			const searchFn = async () => ({
				stacks: [mockStackInfo],
				continuationToken: "next-page",
			});
			const stacks = mockStacksService({
				searchStacks: searchFn,
			});
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const stackH = stackHandlers(stacks);
			app.get("/stacks", stackH.listStacks);

			const res = await app.request("/stacks?query=dev&pageSize=10");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.stacks).toBeArray();
			expect(body.continuationToken).toBe("next-page");
		});

		test("listStacks falls back to listStacks when searchStacks not available", async () => {
			const stacks = mockStacksService();
			// searchStacks is optional — not set in base mock
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const stackH = stackHandlers(stacks);
			app.get("/stacks", stackH.listStacks);

			const res = await app.request("/stacks?query=dev");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.stacks).toBeArray();
		});

		test("listStacks passes sort params to searchStacks", async () => {
			const searchFn = async (_tid: string, params: Record<string, unknown>) => {
				expect(params.sortBy).toBe("lastUpdated");
				expect(params.sortOrder).toBe("desc");
				return { stacks: [] };
			};
			const stacks = mockStacksService({ searchStacks: searchFn });
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const stackH = stackHandlers(stacks);
			app.get("/stacks", stackH.listStacks);

			const res = await app.request("/stacks?sortBy=lastUpdated&sortOrder=desc");
			expect(res.status).toBe(200);
		});
	});
});
