import { describe, expect, test } from "bun:test";
import type { AuthService } from "@procella/auth";
import type { Caller } from "@procella/types";
import { SignJWT } from "jose";
import { createSubscriptionTicketService } from "../subscription-tickets.js";
import { authenticateTrpcCaller } from "./trpc-auth.js";

const SIGNING_KEY = "ticket-signing-key-ticket-signing-key";
const WRONG_SIGNING_KEY = "wrong-ticket-signing-key-wrong-key";

const caller: Caller = {
	tenantId: "tenant-1",
	orgSlug: "my-org",
	userId: "user-1",
	login: "alice",
	roles: ["admin"],
	principalType: "user",
};

function mockAuthService(returnCaller: Caller | null): AuthService {
	return {
		authenticate: async () => {
			if (!returnCaller) {
				throw new Error("unauthorized");
			}
			return returnCaller;
		},
		authenticateUpdateToken: async () => ({ updateId: "u-1", stackId: "s-1" }),
		resolveUserDisplayName: async () => null,
	};
}

describe("authenticateTrpcCaller", () => {
	test("falls back to header auth when no ticket is present", async () => {
		const result = await authenticateTrpcCaller(
			new Request("https://procella.dev/trpc"),
			undefined,
			{
				auth: mockAuthService(caller),
				verifySubscriptionTicket: createSubscriptionTicketService(SIGNING_KEY).verifyTicket,
			},
		);

		expect(result).toEqual({ caller, invalidTicket: false });
	});

	test("rejects an expired ticket", async () => {
		const expiredTicket = await new SignJWT({
			tenantId: caller.tenantId,
			orgSlug: caller.orgSlug,
			userId: caller.userId,
			login: caller.login,
			roles: [...caller.roles],
			principalType: caller.principalType,
		})
			.setProtectedHeader({ alg: "HS256", typ: "JWT" })
			.setIssuer("procella")
			.setAudience("procella:trpc-subscription")
			.setIssuedAt(Math.floor(Date.now() / 1000) - 120)
			.setExpirationTime(Math.floor(Date.now() / 1000) - 60)
			.sign(new TextEncoder().encode(SIGNING_KEY));

		const result = await authenticateTrpcCaller(
			new Request("https://procella.dev/trpc/updates.onEvents", { method: "GET" }),
			expiredTicket,
			{
				auth: mockAuthService(null),
				verifySubscriptionTicket: createSubscriptionTicketService(SIGNING_KEY).verifyTicket,
			},
		);

		expect(result).toEqual({ caller: null, invalidTicket: true });
	});

	test("rejects a wrong-signature ticket", async () => {
		const wrongSignatureTicket =
			await createSubscriptionTicketService(WRONG_SIGNING_KEY).issueTicket(caller);

		const result = await authenticateTrpcCaller(
			new Request("https://procella.dev/trpc/updates.onEvents", { method: "GET" }),
			wrongSignatureTicket,
			{
				auth: mockAuthService(null),
				verifySubscriptionTicket: createSubscriptionTicketService(SIGNING_KEY).verifyTicket,
			},
		);

		expect(result).toEqual({ caller: null, invalidTicket: true });
	});

	test("accepts a valid ticket and reconstructs the caller from claims", async () => {
		const service = createSubscriptionTicketService(SIGNING_KEY);
		const ticket = await service.issueTicket(caller);

		const result = await authenticateTrpcCaller(
			new Request("https://procella.dev/trpc/updates.onEvents", { method: "GET" }),
			ticket,
			{
				auth: mockAuthService(null),
				verifySubscriptionTicket: service.verifyTicket,
			},
		);

		expect(result).toEqual({ caller, invalidTicket: false });
	});
});
