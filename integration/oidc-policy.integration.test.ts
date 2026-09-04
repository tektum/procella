import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type Database, oidcTrustPolicies } from "@procella/db";
import { type OidcTrustPolicy, PostgresTrustPolicyRepository } from "@procella/oidc";
import { sql } from "drizzle-orm";
import { getTestDb, truncateTables } from "./setup.js";

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

beforeAll(() => {
	db = getTestDb();
	repo = new PostgresTrustPolicyRepository(db);
});

afterEach(async () => {
	await truncateTables();
});

describe("PostgresTrustPolicyRepository — integration", () => {
	test("database retains tenant-scoped issuer uniqueness during phase A", async () => {
		const [row] = await db.execute(
			sql`SELECT indexdef FROM pg_indexes
				WHERE schemaname = current_schema()
					AND tablename = 'oidc_trust_policies'
					AND indexname = 'idx_oidc_trust_org_issuer'`,
		);

		if (!row || typeof row.indexdef !== "string") {
			throw new Error("OIDC trust policy index is missing");
		}
		expect(row.indexdef).toContain("USING btree (tenant_id, org_slug, issuer)");
	});

	test("ownership lookup exposes inactive cross-tenant legacy rows for fail-closed exchange", async () => {
		await db.insert(oidcTrustPolicies).values([
			{
				...policyInput(TENANT_ID),
				active: false,
			},
			{
				...policyInput(OTHER_TENANT_ID),
				displayName: "Legacy colliding policy",
				claimConditions: {
					repository_owner_id: "98765",
					repository_id: "43210",
				},
			},
		]);

		const policies = await repo.findByOrgSlugAndIssuer(ORG_SLUG, ISSUER);
		expect(policies.map((policy) => `${policy.tenantId}:${policy.active}`).sort()).toEqual([
			`${OTHER_TENANT_ID}:true`,
			`${TENANT_ID}:false`,
		]);
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
