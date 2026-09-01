import { describe, expect, mock, test } from "bun:test";
import {
	OidcPolicyConflictError,
	type OidcTrustPolicy,
	type TrustPolicyRepository,
} from "@procella/oidc";
import type { TRPCContext } from "../trpc.js";
import { oidcRouter } from "./oidc.js";

// ============================================================================
// Mock Data
// ============================================================================

const VALID_UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

const mockPolicy: OidcTrustPolicy = {
	id: VALID_UUID,
	tenantId: "t-1",
	orgSlug: "my-org",
	provider: "github-actions",
	displayName: "CI Deploy Policy",
	issuer: "https://token.actions.githubusercontent.com",
	maxExpiration: 7200,
	claimConditions: {
		iss: "https://token.actions.githubusercontent.com",
		repository_owner: "my-org",
	},
	grantedRole: "member",
	active: true,
	createdAt: new Date("2025-01-01"),
	updatedAt: new Date("2025-01-01"),
};

// ============================================================================
// Mock Context
// ============================================================================

function mockPolicies(overrides?: Partial<TrustPolicyRepository>): TrustPolicyRepository {
	return {
		findByOrgSlugAndIssuer: mock(async () => [mockPolicy]),
		findByOrgSlug: mock(async () => [mockPolicy]),
		listByOrgSlug: mock(async () => [mockPolicy]),
		create: mock(async () => mockPolicy),
		update: mock(async () => mockPolicy),
		delete: mock(async () => {}),
		...overrides,
	};
}

function mockContext(overrides?: Partial<TRPCContext>): TRPCContext {
	return {
		caller: {
			tenantId: "t-1",
			orgSlug: "my-org",
			userId: "u-1",
			login: "admin",
			roles: ["admin"],
			principalType: "user",
		},
		resolveUserDisplayName: (subject) => Promise.resolve(subject),
		db: {} as never,
		dbUrl: "",
		stacks: {} as never,
		audit: {} as never,
		updates: {} as never,
		webhooks: {} as never,
		esc: {} as never,
		github: null,
		oidcPolicies: mockPolicies(),
		...overrides,
	};
}

const viewerCtx = (): TRPCContext =>
	mockContext({
		caller: {
			tenantId: "t-1",
			orgSlug: "my-org",
			userId: "u-2",
			login: "viewer",
			roles: ["viewer"],
			principalType: "user",
		},
	});

const noOidcCtx = (): TRPCContext => mockContext({ oidcPolicies: null });

// ============================================================================
// Tests
// ============================================================================

describe("oidcRouter", () => {
	describe("listPolicies", () => {
		test("admin can list policies", async () => {
			const ctx = mockContext();
			const caller = oidcRouter.createCaller(ctx);
			const result = await caller.listPolicies();
			expect(result).toBeArray();
			expect(result).toHaveLength(1);
			expect(result[0]?.id).toBe(VALID_UUID);
		});

		test("non-admin is rejected", () => {
			const caller = oidcRouter.createCaller(viewerCtx());
			return expect(caller.listPolicies()).rejects.toThrow("Admin role required");
		});

		test("returns PRECONDITION_FAILED when OIDC disabled", () => {
			const caller = oidcRouter.createCaller(noOidcCtx());
			return expect(caller.listPolicies()).rejects.toThrow("OIDC is not enabled");
		});
	});

	describe("createPolicy", () => {
		const validInput = {
			provider: "github-actions" as const,
			displayName: "CI Policy",
			issuer: "https://token.actions.githubusercontent.com",
			claimConditions: {
				iss: "https://token.actions.githubusercontent.com",
				repository_owner: "my-org",
			},
			grantedRole: "member" as const,
		};

		test("admin can create policy", async () => {
			const ctx = mockContext();
			const caller = oidcRouter.createCaller(ctx);
			const result = await caller.createPolicy(validInput);
			expect(result.id).toBe(VALID_UUID);
			expect(ctx.oidcPolicies?.create).toHaveBeenCalledTimes(1);
		});

		test("non-admin is rejected", () => {
			const caller = oidcRouter.createCaller(viewerCtx());
			return expect(caller.createPolicy(validInput)).rejects.toThrow("Admin role required");
		});

		test("invalid URL in issuer is rejected", () => {
			const ctx = mockContext();
			const caller = oidcRouter.createCaller(ctx);
			return expect(caller.createPolicy({ ...validInput, issuer: "not-a-url" })).rejects.toThrow();
		});

		test("rejects issuer-only claim conditions at create", () => {
			const caller = oidcRouter.createCaller(mockContext());

			return expect(
				caller.createPolicy({
					...validInput,
					claimConditions: { iss: "https://token.actions.githubusercontent.com" },
				}),
			).rejects.toThrow("at least two claim conditions");
		});

		test("rejects wildcard sub-only claim conditions at create", () => {
			const caller = oidcRouter.createCaller(mockContext());

			return expect(
				caller.createPolicy({
					...validInput,
					claimConditions: { sub: "*" },
				}),
			).rejects.toThrow("at least two claim conditions");
		});

		test("surfaces policy_conflict as conflict error", () => {
			const ctx = mockContext({
				oidcPolicies: mockPolicies({
					create: mock(async () => {
						throw new OidcPolicyConflictError();
					}),
				}),
			});
			const caller = oidcRouter.createCaller(ctx);

			return expect(caller.createPolicy(validInput)).rejects.toThrow(
				"OIDC trust policy with this org/issuer pair already exists",
			);
		});
	});

	describe("updatePolicy", () => {
		test("admin can update policy", async () => {
			const ctx = mockContext();
			const caller = oidcRouter.createCaller(ctx);
			const result = await caller.updatePolicy({ id: VALID_UUID, displayName: "Updated Name" });
			expect(result.id).toBe(VALID_UUID);
			expect(ctx.oidcPolicies?.update).toHaveBeenCalledWith(VALID_UUID, "t-1", {
				displayName: "Updated Name",
			});
		});

		test("non-admin is rejected", () => {
			const caller = oidcRouter.createCaller(viewerCtx());
			return expect(caller.updatePolicy({ id: VALID_UUID, displayName: "x" })).rejects.toThrow(
				"Admin role required",
			);
		});
	});

	describe("deletePolicy", () => {
		test("admin can delete policy", async () => {
			const ctx = mockContext();
			const caller = oidcRouter.createCaller(ctx);
			const result = await caller.deletePolicy({ id: VALID_UUID });
			expect(result.success).toBe(true);
			expect(ctx.oidcPolicies?.delete).toHaveBeenCalledWith(VALID_UUID, "t-1");
		});

		test("non-admin is rejected", () => {
			const caller = oidcRouter.createCaller(viewerCtx());
			return expect(caller.deletePolicy({ id: VALID_UUID })).rejects.toThrow("Admin role required");
		});

		test("invalid UUID is rejected", () => {
			const ctx = mockContext();
			const caller = oidcRouter.createCaller(ctx);
			return expect(caller.deletePolicy({ id: "not-a-uuid" })).rejects.toThrow();
		});
	});
});
