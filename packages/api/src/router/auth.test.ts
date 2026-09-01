import { describe, expect, test } from "bun:test";
import type { TRPCContext } from "../trpc.js";
import { authRouter } from "./auth.js";

function mockContext(caller: TRPCContext["caller"]): TRPCContext {
	return {
		caller,
		resolveUserDisplayName: async () => null,
		db: {} as never,
		dbUrl: "",
		stacks: {} as never,
		audit: {} as never,
		updates: {} as never,
		webhooks: {} as never,
		esc: {} as never,
		github: null,
	};
}

describe("authRouter", () => {
	test("returns authorization data from the verified caller", async () => {
		const caller = authRouter.createCaller(
			mockContext({
				tenantId: "tenant-1",
				orgSlug: "my-org",
				userId: "user-1",
				login: "admin@example.com",
				roles: ["admin", "member"],
				principalType: "user",
			}),
		);

		const result = await caller.current();
		expect(result).toEqual({
			tenantId: "tenant-1",
			roles: ["admin", "member"],
		});
	});

	test("rejects unauthenticated callers", () => {
		const caller = authRouter.createCaller(mockContext(null));

		return expect(caller.current()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
