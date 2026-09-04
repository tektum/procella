import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "@procella/db";
import { Role } from "@procella/types";
import { PostgresTrustPolicyRepository } from "./policy.js";

type PolicyRow = {
	id: string;
	tenantId: string;
	orgSlug: string;
	provider: string;
	displayName: string;
	issuer: string;
	maxExpiration: number;
	claimConditions: Record<string, string>;
	grantedRole: Role;
	active: boolean;
	createdAt: Date;
	updatedAt: Date;
};

function makeRow(overrides: Partial<PolicyRow> = {}): PolicyRow {
	return {
		id: "policy-1",
		tenantId: "tenant-1",
		orgSlug: "acme",
		provider: "github-actions",
		displayName: "Test Policy",
		issuer: "https://token.actions.githubusercontent.com",
		maxExpiration: 3600,
		claimConditions: {
			iss: "https://token.actions.githubusercontent.com",
			repository: "acme/procella",
		},
		grantedRole: Role.Member,
		active: true,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		...overrides,
	};
}

function createMockDb(options?: {
	selectRows?: PolicyRow[];
	insertRows?: PolicyRow[];
	insertError?: unknown;
	updateRows?: PolicyRow[];
}) {
	const calls: { method: string; args?: unknown }[] = [];

	const mockSelectWhere = mock((condition: unknown) => {
		calls.push({ method: "select.where", args: condition });
		return Promise.resolve(options?.selectRows ?? []);
	});
	const mockSelectFrom = mock((table: unknown) => {
		calls.push({ method: "select.from", args: table });
		return { where: mockSelectWhere };
	});
	const mockSelect = mock(() => {
		calls.push({ method: "select" });
		return { from: mockSelectFrom };
	});

	const mockInsertReturning = mock(() => {
		calls.push({ method: "insert.returning" });
		if (options?.insertError) {
			return Promise.reject(options.insertError);
		}
		return Promise.resolve(options?.insertRows ?? []);
	});
	const mockInsertValues = mock((values: unknown) => {
		calls.push({ method: "insert.values", args: values });
		return { returning: mockInsertReturning };
	});
	const mockInsert = mock((table: unknown) => {
		calls.push({ method: "insert", args: table });
		return { values: mockInsertValues };
	});

	const mockUpdateReturning = mock(() => {
		calls.push({ method: "update.returning" });
		return Promise.resolve(options?.updateRows ?? []);
	});
	const mockUpdateWhere = mock((condition: unknown) => {
		calls.push({ method: "update.where", args: condition });
		return { returning: mockUpdateReturning };
	});
	const mockUpdateSet = mock((data: unknown) => {
		calls.push({ method: "update.set", args: data });
		return { where: mockUpdateWhere };
	});
	const mockUpdate = mock((table: unknown) => {
		calls.push({ method: "update", args: table });
		return { set: mockUpdateSet };
	});

	const mockDeleteWhere = mock((condition: unknown) => {
		calls.push({ method: "delete.where", args: condition });
		return Promise.resolve();
	});
	const mockDelete = mock((table: unknown) => {
		calls.push({ method: "delete", args: table });
		return { where: mockDeleteWhere };
	});

	const mockExecute = mock(() => {
		calls.push({ method: "execute" });
		return Promise.resolve([]);
	});

	const mockDb = {
		select: mockSelect,
		insert: mockInsert,
		update: mockUpdate,
		delete: mockDelete,
		execute: mockExecute,
		transaction: mock((callback: (tx: unknown) => unknown) => callback(mockDb)),
	};

	return {
		db: mockDb as unknown as Database,
		calls,
		mockSelectWhere,
		mockInsertReturning,
		mockUpdateReturning,
		mockDeleteWhere,
	};
}

describe("PostgresTrustPolicyRepository", () => {
	let mockRow: PolicyRow;

	beforeEach(() => {
		mockRow = makeRow();
	});

	test("findByOrgSlugAndIssuer returns active and inactive ownership rows", async () => {
		const rows = [mockRow, makeRow({ id: "policy-2", tenantId: "tenant-2", active: false })];
		const { db } = createMockDb({ selectRows: rows });
		const repo = new PostgresTrustPolicyRepository(db);

		const result = await repo.findByOrgSlugAndIssuer(
			"acme",
			"https://token.actions.githubusercontent.com",
		);

		expect(result.map((policy) => [policy.id, policy.tenantId, policy.active])).toEqual([
			["policy-1", "tenant-1", true],
			["policy-2", "tenant-2", false],
		]);
	});

	test("listByOrgSlug requires tenant scope and returns active and inactive policies", async () => {
		const rows = [
			mockRow,
			makeRow({ id: "policy-2", active: false, displayName: "Inactive Policy" }),
		];
		const { db, mockSelectWhere } = createMockDb({ selectRows: rows });
		const repo = new PostgresTrustPolicyRepository(db);

		const result = await repo.listByOrgSlug("acme", "tenant-1");

		expect(result).toHaveLength(2);
		expect(result.map((policy) => policy.active)).toEqual([true, false]);
		expect(mockSelectWhere).toHaveBeenCalledTimes(1);
	});

	test("create locks and checks ownership before inserting without updates", async () => {
		const { db, calls } = createMockDb({ insertRows: [mockRow] });
		const repo = new PostgresTrustPolicyRepository(db);

		const result = await repo.create({
			tenantId: "tenant-1",
			orgSlug: "acme",
			provider: "github-actions",
			displayName: "Test Policy",
			issuer: "https://token.actions.githubusercontent.com",
			maxExpiration: 3600,
			claimConditions: {
				repository_owner_id: "12345",
				repository_id: "67890",
			},
			grantedRole: Role.Member,
			active: true,
		});

		expect(result.id).toBe("policy-1");
		expect(calls.some((call) => call.method === "insert.returning")).toBe(true);
		expect(calls.some((call) => call.method.startsWith("update"))).toBe(false);
		expect(calls.findIndex((call) => call.method === "execute")).toBeLessThan(
			calls.findIndex((call) => call.method === "insert"),
		);
	});

	test("same-tenant issuer conflict does not mutate existing policies", async () => {
		const { db, calls } = createMockDb({
			insertError: Object.assign(new Error("duplicate key value violates unique constraint"), {
				code: "23505",
				constraint: "idx_oidc_trust_org_issuer",
			}),
		});
		const repo = new PostgresTrustPolicyRepository(db);

		await expect(
			repo.create({
				tenantId: "tenant-1",
				orgSlug: "acme",
				provider: "github-actions",
				displayName: "Second Policy",
				issuer: "https://token.actions.githubusercontent.com",
				maxExpiration: 3600,
				claimConditions: {
					repository_owner_id: "12345",
					repository_id: "67890",
				},
				grantedRole: Role.Member,
				active: true,
			}),
		).rejects.toMatchObject({ code: "policy_conflict" });
		expect(calls.some((call) => call.method.startsWith("update"))).toBe(false);
	});

	test("cross-tenant issuer conflict is generic and does not mutate existing policies", async () => {
		const { db, calls } = createMockDb({ selectRows: [mockRow] });
		const repo = new PostgresTrustPolicyRepository(db);

		await expect(
			repo.create({
				tenantId: "tenant-2",
				orgSlug: "acme",
				provider: "github-actions",
				displayName: "Conflicting Policy",
				issuer: "https://token.actions.githubusercontent.com",
				maxExpiration: 3600,
				claimConditions: {
					repository_owner_id: "98765",
					repository_id: "43210",
				},
				grantedRole: Role.Member,
				active: true,
			}),
		).rejects.toMatchObject({
			code: "policy_conflict",
			message: "OIDC trust policy with this org/issuer pair already exists",
		});
		expect(calls.some((call) => call.method.startsWith("update"))).toBe(false);
		expect(calls.some((call) => call.method.startsWith("insert"))).toBe(false);
	});

	test("create surfaces policy_display_name_conflict when the displayName unique index fires (PR #149 review — distinct error per constraint)", () => {
		const { db } = createMockDb({
			insertError: Object.assign(new Error("duplicate key value violates unique constraint"), {
				code: "23505",
				constraint: "idx_oidc_trust_org_name",
			}),
		});
		const repo = new PostgresTrustPolicyRepository(db);

		return expect(
			repo.create({
				tenantId: "tenant-2",
				orgSlug: "acme",
				provider: "github-actions",
				displayName: "Existing Display Name",
				issuer: "https://token.actions.githubusercontent.com",
				maxExpiration: 3600,
				claimConditions: {
					iss: "https://token.actions.githubusercontent.com",
					repository_owner: "myorg",
				},
				grantedRole: Role.Member,
				active: true,
			}),
		).rejects.toMatchObject({
			code: "policy_display_name_conflict",
			message: "OIDC trust policy with this display name already exists in the tenant",
		});
	});

	test("create throws when insert returns empty array", async () => {
		const { db } = createMockDb({ insertRows: [] });
		const repo = new PostgresTrustPolicyRepository(db);

		expect(
			repo.create({
				tenantId: "tenant-1",
				orgSlug: "acme",
				provider: "github-actions",
				displayName: "Test Policy",
				issuer: "https://token.actions.githubusercontent.com",
				maxExpiration: 3600,
				claimConditions: {
					iss: "https://token.actions.githubusercontent.com",
					repository: "acme/procella",
				},
				grantedRole: Role.Member,
				active: true,
			}),
		).rejects.toThrow("Failed to create trust policy");
	});

	test("update returns mapped row", async () => {
		const { db, calls } = createMockDb({ updateRows: [mockRow] });
		const repo = new PostgresTrustPolicyRepository(db);

		const result = await repo.update("policy-1", "tenant-1", {
			displayName: "Renamed Policy",
			active: false,
		});

		expect(result.id).toBe("policy-1");
		expect(result.grantedRole).toBe(Role.Member);
		expect(calls.some((call) => call.method === "update.set")).toBe(true);
	});

	test("update throws when policy is not found", async () => {
		const { db } = createMockDb({ updateRows: [] });
		const repo = new PostgresTrustPolicyRepository(db);

		expect(repo.update("missing-policy", "tenant-1", { active: false })).rejects.toThrow(
			"Trust policy missing-policy not found",
		);
	});

	test("delete does not throw", () => {
		const { db, mockDeleteWhere } = createMockDb();
		const repo = new PostgresTrustPolicyRepository(db);

		const deletion = repo.delete("policy-1", "tenant-1");
		expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
		return expect(deletion).resolves.toBeUndefined();
	});
});
