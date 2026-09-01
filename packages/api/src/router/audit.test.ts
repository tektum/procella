import { describe, expect, mock, test } from "bun:test";
import type { TRPCContext } from "../trpc.js";
import { auditRouter } from "./audit.js";

// ============================================================================
// Mock Context
// ============================================================================

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
		audit: {
			log: mock(() => {}),
			query: mock(async () => ({ entries: [], total: 0 })),
			export: mock(async () => []),
		},
		updates: {} as never,
		webhooks: {} as never,
		esc: {} as never,
		github: null,
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("auditRouter", () => {
	describe("list", () => {
		test("calls audit.query with correct params", async () => {
			const ctx = mockContext();
			const caller = auditRouter.createCaller(ctx);

			const result = await caller.list({ page: 1, pageSize: 10 });
			expect(result).toEqual({ entries: [], total: 0 });
			expect(ctx.audit.query).toHaveBeenCalledTimes(1);
		});

		test("uses default page and pageSize", async () => {
			const ctx = mockContext();
			const caller = auditRouter.createCaller(ctx);

			await caller.list({});
			const args = (ctx.audit.query as ReturnType<typeof mock>).mock.calls[0];
			expect(args[1]).toMatchObject({ page: 1, pageSize: 50 });
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
			const caller = auditRouter.createCaller(ctx);

			await expect(caller.list({})).rejects.toThrow("Admin role required");
		});

		test("validates pageSize bounds", async () => {
			const ctx = mockContext();
			const caller = auditRouter.createCaller(ctx);

			await expect(caller.list({ pageSize: 0 })).rejects.toThrow();
			await expect(caller.list({ pageSize: 201 })).rejects.toThrow();
		});
	});

	describe("export", () => {
		test("calls audit.export with correct params", async () => {
			const ctx = mockContext();
			const caller = auditRouter.createCaller(ctx);

			const result = await caller.export({});
			expect(result).toEqual([]);
			expect(ctx.audit.export).toHaveBeenCalledTimes(1);
		});

		test("rejects non-admin callers", async () => {
			const ctx = mockContext({
				caller: {
					tenantId: "t-1",
					orgSlug: "org",
					userId: "u-2",
					login: "member",
					roles: ["member"],
					principalType: "user",
				},
			});
			const caller = auditRouter.createCaller(ctx);

			await expect(caller.export({})).rejects.toThrow("Admin role required");
		});
	});
});
