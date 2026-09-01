import { describe, expect, test } from "bun:test";
import { adminProcedure, protectedProcedure, router, type TRPCContext } from "./trpc.js";

function buildContext(overrides?: Partial<TRPCContext>): TRPCContext {
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
		oidcPolicies: null,
		...overrides,
	};
}

describe("trpc procedures", () => {
	test("protectedProcedure rejects unauthenticated callers with UNAUTHORIZED", async () => {
		const testRouter = router({
			whoami: protectedProcedure.query(({ ctx }) => ctx.caller.tenantId),
		});

		const caller = testRouter.createCaller(buildContext({ caller: null }));

		await expect(caller.whoami()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: "Authentication required",
		});
	});

	test("protectedProcedure proceeds when caller is set", async () => {
		const testRouter = router({
			whoami: protectedProcedure.query(({ ctx }) => ({
				tenantId: ctx.caller.tenantId,
				login: ctx.caller.login,
			})),
		});

		const caller = testRouter.createCaller(buildContext());

		await expect(caller.whoami()).resolves.toEqual({ tenantId: "t-1", login: "admin" });
	});

	test("adminProcedure rejects unauthenticated callers with UNAUTHORIZED", async () => {
		const testRouter = router({
			adminOnly: adminProcedure.query(({ ctx }) => ctx.caller.roles),
		});

		const caller = testRouter.createCaller(buildContext({ caller: null }));

		await expect(caller.adminOnly()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: "Authentication required",
		});
	});

	test("adminProcedure rejects non-admin callers with FORBIDDEN", async () => {
		const testRouter = router({
			adminOnly: adminProcedure.query(({ ctx }) => ctx.caller.roles),
		});

		const caller = testRouter.createCaller(
			buildContext({
				caller: {
					tenantId: "t-1",
					orgSlug: "my-org",
					userId: "u-2",
					login: "viewer",
					roles: ["viewer"],
					principalType: "user",
				},
			}),
		);

		await expect(caller.adminOnly()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Admin role required",
		});
	});

	test("adminProcedure proceeds when caller has admin role", async () => {
		const testRouter = router({
			adminOnly: adminProcedure.query(({ ctx }) => ({
				tenantId: ctx.caller.tenantId,
				roles: ctx.caller.roles,
			})),
		});

		const caller = testRouter.createCaller(buildContext());

		await expect(caller.adminOnly()).resolves.toEqual({
			tenantId: "t-1",
			roles: ["admin"],
		});
	});
});
