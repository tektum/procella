import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { type Database, oidcTrustPolicies } from "@procella/db";
import { type OidcTrustPolicy, PostgresTrustPolicyRepository } from "@procella/oidc";
import { sql } from "drizzle-orm";
import { getTestDb, getTestDbUrl, truncateTables } from "./setup.js";

let db: Database;
let repo: PostgresTrustPolicyRepository;

const TENANT_ID = "integration-test-tenant";
const OTHER_TENANT_ID = "integration-test-other-tenant";
const ORG_SLUG = "integration-test-org";
const ISSUER = "https://token.actions.githubusercontent.com";

type PolicyInput = Parameters<PostgresTrustPolicyRepository["create"]>[0];

function policyInput(tenantId: string, overrides: Partial<PolicyInput> = {}): PolicyInput {
	return {
		tenantId,
		orgSlug: ORG_SLUG,
		provider: "github-actions",
		displayName: `${tenantId} policy`,
		issuer: ISSUER,
		maxExpiration: 3600,
		claimConditions: {
			repository_owner_id: "12345",
			repository_id: "67890",
		},
		grantedRole: "member",
		active: true,
		...overrides,
	};
}

function getSqlState(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; depth < 10 && current != null; depth++) {
		if (typeof current !== "object") return undefined;
		const record = current as Record<string, unknown>;
		for (const key of ["code", "errno"] as const) {
			const value = record[key];
			const normalized = typeof value === "number" ? String(value) : value;
			if (typeof normalized === "string" && /^[0-9A-Z]{5}$/i.test(normalized)) {
				return normalized;
			}
		}
		if (Array.isArray(record.errors)) {
			for (const inner of record.errors) {
				const innerCode = getSqlState(inner);
				if (innerCode) return innerCode;
			}
		}
		current = record.cause;
	}
	return undefined;
}

async function readOwnershipMigrationStatements(): Promise<string[]> {
	const migration = await readFile(
		new URL("../packages/db/drizzle/0018_global_oidc_policy_ownership.sql", import.meta.url),
		"utf8",
	);
	return migration
		.split("--> statement-breakpoint")
		.map((statement) => statement.trim())
		.filter(Boolean);
}

beforeAll(() => {
	db = getTestDb();
	repo = new PostgresTrustPolicyRepository(db);
});

afterEach(async () => {
	await truncateTables();
});

describe("PostgresTrustPolicyRepository — integration", () => {
	test("database enforces global issuer ownership after phase B", async () => {
		const [row] = await db.execute(
			sql`SELECT indexdef FROM pg_indexes
				WHERE schemaname = current_schema()
					AND tablename = 'oidc_trust_policies'
					AND indexname = 'idx_oidc_trust_org_issuer'`,
		);

		if (!row || typeof row.indexdef !== "string") {
			throw new Error("OIDC trust policy index is missing");
		}
		expect(row.indexdef).toContain("USING btree (org_slug, issuer)");
		expect(row.indexdef).not.toContain("tenant_id");
	});

	test("migration lock blocks new ownership reads before the index swap", async () => {
		const statements = await readOwnershipMigrationStatements();
		expect(statements[0]).toBe(
			'LOCK TABLE "oidc_trust_policies" IN ACCESS EXCLUSIVE MODE;',
		);

		const { SQL } = require("bun") as typeof import("bun");
		const reader = new SQL({ url: getTestDbUrl(), max: 1 });
		await reader.unsafe("SET statement_timeout = 250");
		try {
			await db.transaction(async (tx) => {
				await tx.execute(sql.raw(statements[0]!));
				let readError: unknown;
				try {
					await reader.unsafe('SELECT id FROM "oidc_trust_policies" LIMIT 1');
				} catch (error) {
					readError = error;
				}
				expect(getSqlState(readError)).toBe("57014");
			});
		} finally {
			await reader.close();
		}
	});

	test("ownership migration fails closed on ambiguous legacy rows", async () => {
		const statements = await readOwnershipMigrationStatements();
		expect(statements).toHaveLength(4);

		await db.transaction(async (tx) => {
			await tx.execute(sql.raw(`
				CREATE TEMP TABLE oidc_trust_policies (
					tenant_id text NOT NULL,
					org_slug text NOT NULL,
					issuer text NOT NULL,
					active boolean NOT NULL
				) ON COMMIT DROP
			`));
			await tx.execute(
				sql.raw(`CREATE UNIQUE INDEX "idx_oidc_trust_org_issuer"
					ON oidc_trust_policies (tenant_id, org_slug, issuer)`),
			);
			await tx.execute(sql.raw(`
				INSERT INTO oidc_trust_policies (tenant_id, org_slug, issuer, active) VALUES
					('legacy-tenant-a', '${ORG_SLUG}', '${ISSUER}', false),
					('legacy-tenant-b', '${ORG_SLUG}', '${ISSUER}', true)
			`));

			await tx.execute(sql.raw(statements[0]!));
			await tx.execute(sql.raw("SAVEPOINT oidc_ownership_preflight"));
			let migrationError: unknown;
			try {
				await tx.execute(sql.raw(statements[1]!));
			} catch (error) {
				migrationError = error;
				await tx.execute(sql.raw("ROLLBACK TO SAVEPOINT oidc_ownership_preflight"));
			}

			if (!(migrationError instanceof Error)) {
				throw new Error("Expected ownership migration preflight to fail");
			}
			expect(migrationError.message).toContain(
				"OIDC trust policy ownership migration blocked: reconcile duplicate (org_slug, issuer) rows before retrying",
			);
			expect(migrationError.message).not.toContain("legacy-tenant-a");
			expect(migrationError.message).not.toContain("legacy-tenant-b");

			const [count] = await tx.execute(
				sql.raw("SELECT COUNT(*) AS row_count FROM oidc_trust_policies"),
			);
			expect(Number(count?.row_count)).toBe(2);
			const [index] = await tx.execute(
				sql.raw(
					"SELECT pg_get_indexdef(to_regclass('idx_oidc_trust_org_issuer')) AS indexdef",
				),
			);
			expect(index?.indexdef).toContain("(tenant_id, org_slug, issuer)");
		});
	});

	test("ownership migration preserves unambiguous rows and installs the global index", async () => {
		const statements = await readOwnershipMigrationStatements();
		expect(statements).toHaveLength(4);

		await db.transaction(async (tx) => {
			await tx.execute(sql.raw(`
				CREATE TEMP TABLE oidc_trust_policies (
					tenant_id text NOT NULL,
					org_slug text NOT NULL,
					issuer text NOT NULL,
					active boolean NOT NULL
				) ON COMMIT DROP
			`));
			await tx.execute(
				sql.raw(`CREATE UNIQUE INDEX "idx_oidc_trust_org_issuer"
					ON oidc_trust_policies (tenant_id, org_slug, issuer)`),
			);
			await tx.execute(sql.raw(`
				INSERT INTO oidc_trust_policies (tenant_id, org_slug, issuer, active) VALUES
					('tenant-a', '${ORG_SLUG}', '${ISSUER}', false),
					('tenant-b', '${ORG_SLUG}', '${ISSUER}/other', true)
			`));

			for (const statement of statements) {
				await tx.execute(sql.raw(statement));
			}

			const rows = await tx.execute(
				sql.raw(
					"SELECT tenant_id, issuer, active FROM oidc_trust_policies ORDER BY tenant_id",
				),
			);
			expect(rows).toEqual([
				{ tenant_id: "tenant-a", issuer: ISSUER, active: false },
				{ tenant_id: "tenant-b", issuer: `${ISSUER}/other`, active: true },
			]);
			const [index] = await tx.execute(
				sql.raw(
					"SELECT pg_get_indexdef(to_regclass('idx_oidc_trust_org_issuer')) AS indexdef",
				),
			);
			expect(index?.indexdef).toContain("(org_slug, issuer)");
			expect(index?.indexdef).not.toContain("tenant_id");
		});
	});

	test("create inserts a policy and returns it with generated id", async () => {
		const policy = await repo.create(policyInput(TENANT_ID));

		expect(policy.id).toBeString();
		expect(policy.id.length).toBeGreaterThan(0);
		expect(policy.tenantId).toBe(TENANT_ID);
		expect(policy.orgSlug).toBe(ORG_SLUG);
		expect(policy.provider).toBe("github-actions");
		expect(policy.displayName).toBe(`${TENANT_ID} policy`);
		expect(policy.issuer).toBe(ISSUER);
		expect(policy.maxExpiration).toBe(3600);
		expect(policy.claimConditions).toEqual({
			repository_owner_id: "12345",
			repository_id: "67890",
		});
		expect(policy.grantedRole).toBe("member");
		expect(policy.active).toBe(true);
		expect(policy.createdAt).toBeInstanceOf(Date);
	});

	test("same tenant cannot create a second policy for the org and issuer", async () => {
		const established = await repo.create(policyInput(TENANT_ID));

		await expect(
			repo.create(policyInput(TENANT_ID, { displayName: "Duplicate issuer policy" })),
		).rejects.toMatchObject({
			code: "policy_conflict",
			message: "OIDC trust policy with this org/issuer pair already exists",
		});

		const policies = await repo.listByOrgSlug(ORG_SLUG, TENANT_ID);
		expect(policies).toHaveLength(1);
		expect(policies[0]?.id).toBe(established.id);
		expect(policies[0]?.active).toBe(true);
	});

	test("cross-tenant collision fails without mutating the established tenant", async () => {
		const established = await repo.create(policyInput(TENANT_ID));

		await expect(
			repo.create(
				policyInput(OTHER_TENANT_ID, {
					displayName: "Colliding tenant policy",
					claimConditions: {
						repository_owner_id: "98765",
						repository_id: "43210",
					},
				}),
			),
		).rejects.toMatchObject({
			code: "policy_conflict",
			message: "OIDC trust policy with this org/issuer pair already exists",
		});

		const establishedPolicies = await repo.listByOrgSlug(ORG_SLUG, TENANT_ID);
		expect(establishedPolicies).toHaveLength(1);
		expect(establishedPolicies[0]?.id).toBe(established.id);
		expect(establishedPolicies[0]?.active).toBe(true);
		expect(await repo.listByOrgSlug(ORG_SLUG, OTHER_TENANT_ID)).toEqual([]);
	});

	test("concurrent cross-tenant creates establish exactly one tenant", async () => {
		const results = await Promise.allSettled([
			repo.create(policyInput(TENANT_ID)),
			repo.create(policyInput(OTHER_TENANT_ID)),
		]);
		const fulfilled = results.filter(
			(result): result is PromiseFulfilledResult<OidcTrustPolicy> => result.status === "fulfilled",
		);
		const rejected = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0]?.reason).toMatchObject({
			code: "policy_conflict",
			message: "OIDC trust policy with this org/issuer pair already exists",
		});

		const policies = await repo.findByOrgSlugAndIssuer(ORG_SLUG, ISSUER);
		expect(policies).toHaveLength(1);
		expect(policies[0]?.tenantId).toBe(fulfilled[0]?.value.tenantId);
		expect(policies[0]?.active).toBe(true);
	});

	test("global unique index rejects concurrent cross-tenant writes outside the repository", async () => {
		const results = await Promise.allSettled([
			db.insert(oidcTrustPolicies).values(policyInput(TENANT_ID)).returning(),
			db
				.insert(oidcTrustPolicies)
				.values(policyInput(OTHER_TENANT_ID, { displayName: "Other tenant policy" }))
				.returning(),
		]);
		const fulfilled = results.filter((result) => result.status === "fulfilled");
		const rejected = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(getSqlState(rejected[0]?.reason)).toBe("23505");
		expect(await repo.findByOrgSlugAndIssuer(ORG_SLUG, ISSUER)).toHaveLength(1);
	});

	test("list is tenant-scoped and includes inactive policies", async () => {
		const tenantPolicy = await repo.create(policyInput(TENANT_ID));
		await repo.update(tenantPolicy.id, TENANT_ID, { active: false });
		await repo.create(
			policyInput(OTHER_TENANT_ID, {
				displayName: "Other tenant policy",
				issuer: `${ISSUER}/other`,
			}),
		);

		const tenantPolicies = await repo.listByOrgSlug(ORG_SLUG, TENANT_ID);
		expect(tenantPolicies).toHaveLength(1);
		expect(tenantPolicies[0]?.id).toBe(tenantPolicy.id);
		expect(tenantPolicies[0]?.active).toBe(false);

		const otherTenantPolicies = await repo.listByOrgSlug(ORG_SLUG, OTHER_TENANT_ID);
		expect(otherTenantPolicies).toHaveLength(1);
		expect(otherTenantPolicies[0]?.tenantId).toBe(OTHER_TENANT_ID);
	});

	test("update patches allowed fields and enforces tenant isolation", async () => {
		const policy = await repo.create(policyInput(TENANT_ID));

		await expect(
			repo.update(policy.id, OTHER_TENANT_ID, { displayName: "Cross-tenant mutation" }),
		).rejects.toThrow(`Trust policy ${policy.id} not found`);

		const unchanged = await repo.listByOrgSlug(ORG_SLUG, TENANT_ID);
		expect(unchanged[0]?.displayName).toBe(`${TENANT_ID} policy`);

		const updated = await repo.update(policy.id, TENANT_ID, {
			displayName: "Updated Policy",
			maxExpiration: 7200,
			active: false,
		});
		expect(updated.id).toBe(policy.id);
		expect(updated.displayName).toBe("Updated Policy");
		expect(updated.maxExpiration).toBe(7200);
		expect(updated.active).toBe(false);
		expect(updated.issuer).toBe(ISSUER);
	});

	test("delete is tenant-scoped", async () => {
		const policy = await repo.create(policyInput(TENANT_ID));

		await repo.delete(policy.id, OTHER_TENANT_ID);
		expect(await repo.listByOrgSlug(ORG_SLUG, TENANT_ID)).toHaveLength(1);

		await repo.delete(policy.id, TENANT_ID);
		expect(await repo.listByOrgSlug(ORG_SLUG, TENANT_ID)).toEqual([]);
	});
});
