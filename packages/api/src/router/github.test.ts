import { describe, expect, mock, test } from "bun:test";
import type { TRPCContext } from "../trpc.js";
import { githubRouter } from "./github.js";

// ============================================================================
// Mock Context
// ============================================================================

const mockInstallation = {
	id: "inst-uuid-1",
	installationId: 12345,
	tenantId: "t-1",
	accountLogin: "my-org",
	accountType: "Organization" as const,
	repositorySelection: "all" as const,
	createdAt: new Date("2025-01-01"),
	updatedAt: new Date("2025-01-01"),
};

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
		github: {
			handleWebhookEvent: mock(async () => {}),
			postPRComment: mock(async () => {}),
			setCommitStatus: mock(async () => {}),
			saveInstallation: mock(async () => {}),
			removeInstallation: mock(async () => {}),
			getInstallation: mock(async () => mockInstallation),
		},
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("githubRouter", () => {
	describe("installation", () => {
		test("returns installation when github configured", async () => {
			const ctx = mockContext();
			const caller = githubRouter.createCaller(ctx);

			const result = await caller.installation();
			expect(result).toBeDefined();
			expect(result?.installationId).toBe(12345);
		});

		test("returns null when github not configured", async () => {
			const ctx = mockContext({ github: null });
			const caller = githubRouter.createCaller(ctx);

			const result = await caller.installation();
			expect(result).toBeNull();
		});

		test("does not require admin role", async () => {
			const ctx = mockContext({
				caller: {
					tenantId: "t-1",
					orgSlug: "org",
					userId: "u-2",
					login: "viewer",
					roles: ["viewer"],
					principalType: "user",
				},
			});
			const caller = githubRouter.createCaller(ctx);

			const result = await caller.installation();
			expect(result).toBeDefined();
		});
	});

	describe("removeInstallation", () => {
		test("removes existing installation", async () => {
			const ctx = mockContext();
			const caller = githubRouter.createCaller(ctx);

			const result = await caller.removeInstallation();
			expect(result.success).toBe(true);
			expect(ctx.github?.removeInstallation).toHaveBeenCalledWith(12345);
		});

		test("succeeds when no installation exists", async () => {
			const ctx = mockContext({
				github: {
					handleWebhookEvent: mock(async () => {}),
					postPRComment: mock(async () => {}),
					setCommitStatus: mock(async () => {}),
					saveInstallation: mock(async () => {}),
					removeInstallation: mock(async () => {}),
					getInstallation: mock(async () => null),
				},
			});
			const caller = githubRouter.createCaller(ctx);

			const result = await caller.removeInstallation();
			expect(result.success).toBe(true);
			expect(ctx.github?.removeInstallation).not.toHaveBeenCalled();
		});

		test("succeeds when github not configured", async () => {
			const ctx = mockContext({ github: null });
			const caller = githubRouter.createCaller(ctx);

			const result = await caller.removeInstallation();
			expect(result.success).toBe(true);
		});

		test("rejects non-admin callers", async () => {
			const ctx = mockContext({
				caller: {
					tenantId: "t-1",
					orgSlug: "org",
					userId: "u-2",
					login: "viewer",
					roles: ["viewer"],
					principalType: "user",
				},
			});
			const caller = githubRouter.createCaller(ctx);

			await expect(caller.removeInstallation()).rejects.toThrow("Admin role required");
		});
	});
});
