import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "@procella/db";
import { PostgresTrustPolicyRepository } from "@procella/oidc";
import { getTestDb, truncateTables } from "./setup.js";

let db: Database;
let repo: PostgresTrustPolicyRepository;

const TENANT_ID = "integration-test-tenant";
const OTHER_TENANT_ID = "integration-test-other-tenant";
const ORG_SLUG = "integration-test-org";
const ISSUER = "https://token.actions.githubusercontent.com";

beforeAll(() => {
	db = getTestDb();
	repo = new PostgresTrustPolicyRepository(db);
});

afterEach(async () => {
	await truncateTables();
});

describe("PostgresTrustPolicyRepository — integration", () => {
	test("tenant B retires stale tenant A policy for same org and issuer", async () => {
		const tenantAPolicy = await repo.create({
			tenantId: TENANT_ID,
			orgSlug: ORG_SLUG,
			provider: "github-actions",
			displayName: "Tenant A Policy",
			issuer: ISSUER,
			maxExpiration: 3600,
			claimConditions: { iss: ISSUER, repository_owner: "tenant-a-org" },
			grantedRole: "member",
			active: true,
		});

		const tenantBPolicy = await repo.create({
			tenantId: OTHER_TENANT_ID,
			orgSlug: ORG_SLUG,
			provider: "github-actions",
			displayName: "Tenant B Policy",
			issuer: ISSUER,
			maxExpiration: 3600,
			claimConditions: { iss: ISSUER, repository_owner: "tenant-b-org" },
			grantedRole: "admin",
			active: true,
		});

		const tenantAPolicies = await repo.listByOrgSlug(ORG_SLUG, TENANT_ID);
		expect(tenantAPolicies).toHaveLength(1);
		expect(tenantAPolicies[0]?.id).toBe(tenantAPolicy.id);
		expect(tenantAPolicies[0]?.active).toBe(false);

		const tenantBPolicies = await repo.listByOrgSlug(ORG_SLUG, OTHER_TENANT_ID);
		expect(tenantBPolicies).toHaveLength(1);
		expect(tenantBPolicies[0]?.id).toBe(tenantBPolicy.id);
		expect(tenantBPolicies[0]?.active).toBe(true);

		const activePolicies = await repo.findByOrgSlugAndIssuer(ORG_SLUG, ISSUER);
		expect(activePolicies.map((policy) => policy.tenantId)).toEqual([OTHER_TENANT_ID]);
	});

	test("create inserts a policy and returns it with generated id", async () => {
		const policy = await repo.create({
			tenantId: TENANT_ID,
			orgSlug: ORG_SLUG,
			provider: "github-actions",
			displayName: "Test Policy",
			issuer: ISSUER,
			maxExpiration: 3600,
			claimConditions: { iss: ISSUER, repository_owner: "integration-test-org" },
			grantedRole: "member",
			active: true,
		});

		expect(policy.id).toBeString();
		expect(policy.id.length).toBeGreaterThan(0);
		expect(policy.tenantId).toBe(TENANT_ID);
		expect(policy.orgSlug).toBe(ORG_SLUG);
		expect(policy.provider).toBe("github-actions");
		expect(policy.displayName).toBe("Test Policy");
		expect(policy.issuer).toBe(ISSUER);
		expect(policy.maxExpiration).toBe(3600);
		expect(policy.claimConditions).toEqual({
			iss: ISSUER,
			repository_owner: "integration-test-org",
		});
		expect(policy.grantedRole).toBe("member");
		expect(policy.active).toBe(true);
		expect(policy.createdAt).toBeInstanceOf(Date);
	});

	test("findByOrgSlug returns active policies for the org", async () => {
		const policy = await repo.create({
			tenantId: TENANT_ID,
			orgSlug: ORG_SLUG,
			provider: "github-actions",
			displayName: "Test Policy",
			issuer: ISSUER,
			maxExpiration: 3600,
			claimConditions: { iss: ISSUER, repository_owner: "integration-test-org" },
			grantedRole: "member",
			active: true,
		});

		const policies = await repo.findByOrgSlug(ORG_SLUG);
		expect(policies).toBeArray();
		const found = policies.find((p) => p.id === policy.id);
		expect(found).toBeDefined();
		expect(found?.displayName).toBe("Test Policy");
	});

	test("findByOrgSlug does not return policies for different org", async () => {
		const policy = await repo.create({
			tenantId: TENANT_ID,
			orgSlug: ORG_SLUG,
			provider: "github-actions",
			displayName: "Test Policy",
			issuer: ISSUER,
			maxExpiration: 3600,
			claimConditions: { iss: ISSUER, repository_owner: "integration-test-org" },
			grantedRole: "member",
			active: true,
		});

		const policies = await repo.findByOrgSlug("some-other-org");
		const found = policies.find((p) => p.id === policy.id);
		expect(found).toBeUndefined();
	});

	test("update patches allowed fields and enforces tenant isolation", async () => {
		const policy = await repo.create({
			tenantId: TENANT_ID,
			orgSlug: ORG_SLUG,
			provider: "github-actions",
			displayName: "Test Policy",
			issuer: ISSUER,
			maxExpiration: 3600,
			claimConditions: { iss: ISSUER, repository_owner: "integration-test-org" },
			grantedRole: "member",
			active: true,
		});

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
		expect(updated.claimConditions).toEqual({
			iss: ISSUER,
			repository_owner: "integration-test-org",
		});
	});

	test("findByOrgSlug excludes inactive policies", async () => {
		const policy = await repo.create({
			tenantId: TENANT_ID,
			orgSlug: ORG_SLUG,
			provider: "github-actions",
			displayName: "Test Policy",
			issuer: ISSUER,
			maxExpiration: 3600,
			claimConditions: { iss: ISSUER, repository_owner: "integration-test-org" },
			grantedRole: "member",
			active: true,
		});
		await repo.update(policy.id, TENANT_ID, { active: false });

		const policies = await repo.findByOrgSlug(ORG_SLUG);
		const found = policies.find((p) => p.id === policy.id);
		expect(found).toBeUndefined();
	});

	test("listByOrgSlug returns inactive policies too", async () => {
		const policy = await repo.create({
			tenantId: TENANT_ID,
			orgSlug: ORG_SLUG,
			provider: "github-actions",
			displayName: "Test Policy",
			issuer: ISSUER,
			maxExpiration: 3600,
			claimConditions: { iss: ISSUER, repository_owner: "integration-test-org" },
			grantedRole: "member",
			active: true,
		});
		await repo.update(policy.id, TENANT_ID, { active: false });

		const all = await repo.listByOrgSlug(ORG_SLUG);
		const found = all.find((p) => p.id === policy.id);
		expect(found).toBeDefined();
		expect(found?.active).toBe(false);
	});

	test("update returns error when policy not found for tenant", async () => {
		const policy = await repo.create({
			tenantId: TENANT_ID,
			orgSlug: ORG_SLUG,
			provider: "github-actions",
			displayName: "Test Policy",
			issuer: ISSUER,
			maxExpiration: 3600,
			claimConditions: { iss: ISSUER, repository_owner: "integration-test-org" },
			grantedRole: "member",
			active: true,
		});

		await expect(
			repo.update(policy.id, "wrong-tenant", { displayName: "Should Fail" }),
		).rejects.toBeInstanceOf(Error);
	});

	test("delete removes the policy", async () => {
		const policy = await repo.create({
			tenantId: TENANT_ID,
			orgSlug: ORG_SLUG,
			provider: "github-actions",
			displayName: "Test Policy",
			issuer: ISSUER,
			maxExpiration: 3600,
			claimConditions: { iss: ISSUER, repository_owner: "integration-test-org" },
			grantedRole: "member",
			active: true,
		});

		await repo.delete(policy.id, TENANT_ID);

		const policies = await repo.findByOrgSlug(ORG_SLUG);
		const found = policies.find((p) => p.id === policy.id);
		expect(found).toBeUndefined();
	});

	test("delete is tenant-scoped (cannot delete other tenant's policy)", async () => {
		const policy = await repo.create({
			tenantId: TENANT_ID,
			orgSlug: ORG_SLUG,
			provider: "github-actions",
			displayName: "Delete Isolation Test",
			issuer: ISSUER,
			maxExpiration: 3600,
			claimConditions: { iss: ISSUER, repository_owner: "integration-test-org" },
			grantedRole: "viewer",
			active: true,
		});

		await repo.delete(policy.id, "wrong-tenant");

		const policies = await repo.findByOrgSlug(ORG_SLUG);
		const found = policies.find((p) => p.id === policy.id);
		expect(found).toBeDefined();
	});
});
