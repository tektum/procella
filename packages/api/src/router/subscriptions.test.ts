import { describe, expect, mock, test } from "bun:test";
import type { TRPCContext } from "../trpc.js";
import { subscriptionsRouter } from "./subscriptions.js";

function mockContext(overrides?: Partial<TRPCContext>): TRPCContext {
	return {
		caller: {
			tenantId: "t-1",
			orgSlug: "my-org",
			userId: "u-1",
			login: "member",
			roles: ["member"],
			principalType: "user",
		},
		resolveUserDisplayName: (subject) => Promise.resolve(subject),
		issueSubscriptionTicket: mock(async () => "signed-ticket"),
		db: {} as never,
		dbUrl: "",
		stacks: {} as never,
		audit: {} as never,
		updates: {} as never,
		webhooks: {} as never,
		esc: {} as never,
		github: null,
		...overrides,
	};
}

describe("subscriptionsRouter", () => {
	test("createTicket requires authenticated caller", async () => {
		const caller = subscriptionsRouter.createCaller(mockContext({ caller: null }));

		await expect(caller.createTicket()).rejects.toThrow("Authentication required");
	});

	test("createTicket delegates to the configured ticket issuer", async () => {
		const ctx = mockContext();
		const caller = subscriptionsRouter.createCaller(ctx);

		expect(await caller.createTicket()).toEqual({ ticket: "signed-ticket" });
		expect(ctx.issueSubscriptionTicket).toHaveBeenCalledTimes(1);
		expect(ctx.issueSubscriptionTicket).toHaveBeenCalledWith(ctx.caller);
	});
});
