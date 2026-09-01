import { describe, expect, test } from "bun:test";
import type { AuditService } from "@procella/audit";
import type { AuthConfig, AuthService } from "@procella/auth";
import type { Database } from "@procella/db";
import type { EscService } from "@procella/esc";
import type { StacksService } from "@procella/stacks";
import type { Caller } from "@procella/types";
import { UnauthorizedError } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import { createSubscriptionTicketService } from "../subscription-tickets.js";
import { createWebApp } from "./web.js";

const signingKey = "ticket-signing-key-ticket-signing-key";
const subscriptionTickets = createSubscriptionTicketService(signingKey);

const validCaller: Caller = {
	tenantId: "tenant-1",
	orgSlug: "my-org",
	userId: "user-1",
	login: "alice",
	roles: ["admin"],
	principalType: "user",
};

function mockAuthService(): AuthService {
	return {
		authenticate: async (request: Request) => {
			const header = request.headers.get("Authorization");
			if (header !== "token valid-token") {
				throw new UnauthorizedError("Invalid token");
			}
			return validCaller;
		},
		authenticateUpdateToken: async () => ({ updateId: "u-1", stackId: "s-1" }),
		resolveUserDisplayName: async () => null,
		createCliAccessKey: async () => "cli-token",
	};
}

function makeApp(overrides?: {
	issueSubscriptionTicket?: (caller: Caller) => Promise<string>;
	verifySubscriptionTicket?: (ticket: string) => Promise<Caller>;
	authConfig?: AuthConfig;
}) {
	const authConfig: AuthConfig = overrides?.authConfig ?? {
		mode: "dev",
		token: "valid-token",
		userLogin: validCaller.login,
		orgLogin: validCaller.orgSlug,
	};

	return createWebApp({
		auth: mockAuthService(),
		authConfig,
		audit: {} as AuditService,
		db: {} as Database,
		dbUrl: "postgres://test:test@localhost:5432/test",
		stacks: {} as StacksService,
		updates: {} as UpdatesService,
		webhooks: {} as WebhooksService,
		esc: {} as EscService,
		github: null,
		issueSubscriptionTicket:
			overrides?.issueSubscriptionTicket ??
			((caller: Caller) => subscriptionTickets.issueTicket(caller)),
		verifySubscriptionTicket:
			overrides?.verifySubscriptionTicket ??
			((ticket: string) => subscriptionTickets.verifyTicket(ticket)),
	});
}

describe("createWebApp tRPC auth", () => {
	test("subscriptions.createTicket requires authenticated caller", async () => {
		const app = makeApp();
		const res = await app.request("/trpc/subscriptions.createTicket?batch=1", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});

		expect(res.status).toBe(401);
	});

	test("subscriptions.createTicket returns a signed short-lived ticket", async () => {
		const app = makeApp();
		const res = await app.request("/trpc/subscriptions.createTicket?batch=1", {
			method: "POST",
			headers: {
				Authorization: "token valid-token",
				"Content-Type": "application/json",
			},
			body: "{}",
		});
		const body = (await res.json()) as Array<{
			result?: { data?: { json?: { ticket?: string } } };
		}>;

		expect(res.status).toBe(200);
		expect(typeof body[0]?.result?.data?.json?.ticket).toBe("string");
	});

	test("SSE endpoint rejects wrong-signature tickets", async () => {
		const app = makeApp();
		const badTicket = await createSubscriptionTicketService(
			"wrong-ticket-signing-key-wrong-key",
		).issueTicket(validCaller);
		const res = await app.request(
			`/trpc/updates.onEvents?ticket=${encodeURIComponent(badTicket)}&input=%7B%22org%22%3A%22my-org%22%2C%22project%22%3A%22myproj%22%2C%22stack%22%3A%22dev%22%2C%22updateId%22%3A%22upd-1%22%7D`,
		);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ code: "invalid_ticket" });
	});
});

describe("createWebApp auth config discovery", () => {
	test("GET /api/auth/config returns descope config with authBaseUrl when configured", async () => {
		const app = makeApp({
			authConfig: {
				mode: "descope",
				projectId: "P3web123",
				authBaseUrl: "https://auth.procella.cloud",
			},
		});
		const res = await app.request("/api/auth/config");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			mode: "descope",
			projectId: "P3web123",
			authBaseUrl: "https://auth.procella.cloud",
		});
	});

	test("GET /api/auth/config omits authBaseUrl when no custom auth domain is set", async () => {
		const app = makeApp({ authConfig: { mode: "descope", projectId: "P3web123" } });
		const res = await app.request("/api/auth/config");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ mode: "descope", projectId: "P3web123" });
	});
});
