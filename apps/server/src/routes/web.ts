// @procella/server — Web-only route factory for dashboard tRPC API + SSE.
//
// Mounts /trpc/* (queries, mutations, SSE subscriptions) and /api/auth/*
// (auth config discovery, CLI token creation). No Pulumi CLI routes.
// Served from the same origin as the UI — no CORS needed.

import { appRouter } from "@procella/api/src/router/index.js";
import type { TRPCContext } from "@procella/api/src/trpc.js";
import type { AuditService } from "@procella/audit";
import type { AuthConfig, AuthService } from "@procella/auth";
import type { Database } from "@procella/db";
import type { EscService } from "@procella/esc";
import type { GitHubService } from "@procella/github";
import type { OidcService, TrustPolicyRepository } from "@procella/oidc";
import type { StacksService } from "@procella/stacks";
import { tracingMiddleware } from "@procella/telemetry";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { healthHandlers, oauthHandlers } from "../handlers/index.js";
import {
	createIpRateLimiter,
	createSecurityHeadersMiddleware,
	decompress,
	errorHandler,
	requestLogger,
} from "../middleware/index.js";
import type { Env } from "../types.js";
import { authenticateTrpcCaller } from "./trpc-auth.js";

export interface WebAppDeps {
	auth: AuthService;
	authConfig: AuthConfig;
	audit: AuditService;
	db: Database;
	dbUrl: string;
	stacks: StacksService;
	updates: UpdatesService;
	webhooks: WebhooksService;
	esc: EscService;
	github: GitHubService | null;
	issueSubscriptionTicket?: (caller: import("@procella/types").Caller) => Promise<string>;
	oidc?: OidcService | null;
	oidcPolicies?: TrustPolicyRepository | null;
	verifySubscriptionTicket?: (ticket: string) => Promise<import("@procella/types").Caller>;
}

export function createWebApp(deps: WebAppDeps): Hono<Env> {
	const app = new Hono<Env>();

	app.onError(errorHandler());

	// Global middleware — no CORS (same origin as UI). The custom Descope auth
	// domain must be allowed for connect/frame so the login flow can reach it.
	const authOrigin = deps.authConfig.mode === "descope" ? deps.authConfig.authBaseUrl : undefined;
	app.use("*", createSecurityHeadersMiddleware(authOrigin ? [authOrigin] : []));
	app.use("*", tracingMiddleware());
	app.use("*", requestLogger());
	app.use("*", decompress());
	const withCliTokenRateLimit = createIpRateLimiter({ limit: 10 });
	const withOauthTokenRateLimit = createIpRateLimiter({ limit: 30 });
	const withTrpcMutationRateLimit = createIpRateLimiter({
		limit: 60,
		skip: (c) => !isTrpcMutationRequest(c.req.path),
	});

	// Health check
	const health = healthHandlers({ db: deps.db });
	app.get("/healthz", health.health);

	// Auth config discovery — UI fetches this to determine auth mode
	app.get("/api/auth/config", (c) => {
		if (deps.authConfig.mode === "descope") {
			return c.json({
				mode: "descope" as const,
				projectId: deps.authConfig.projectId,
				...(deps.authConfig.authBaseUrl ? { authBaseUrl: deps.authConfig.authBaseUrl } : {}),
			});
		}
		return c.json({ mode: "dev" as const });
	});

	// CLI token creation — browser login flow
	app.post("/api/auth/cli-token", withCliTokenRateLimit, async (c) => {
		if (!deps.auth.createCliAccessKey) {
			return c.json({ error: "CLI token creation not available in this auth mode" }, 400);
		}
		const caller = await deps.auth.authenticate(c.req.raw).catch(() => null);
		if (!caller) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const body = await c.req.json<{ name?: string }>().catch(() => ({}));
		const keyName =
			"name" in body && body.name ? body.name : `procella-cli-${caller.login}-${Date.now()}`;
		const cleartext = await deps.auth.createCliAccessKey(caller, keyName);
		return c.json({ token: cleartext });
	});

	const oauth = oauthHandlers(deps.oidc ?? null);
	app.post("/api/oauth/token", withOauthTokenRateLimit, oauth.tokenExchange);

	// tRPC routes — queries, mutations, SSE subscriptions (short-lived ticket auth for GET)
	app.all("/trpc/*", withTrpcMutationRateLimit, async (c) => {
		const req = c.req.raw;
		const { caller, invalidTicket } = await authenticateTrpcCaller(req, c.req.query("ticket"), {
			auth: deps.auth,
			verifySubscriptionTicket: deps.verifySubscriptionTicket,
		});

		if (invalidTicket) {
			return c.json({ code: "invalid_ticket" }, 401);
		}

		if (!caller) {
			return c.json({ code: 401, message: "Unauthorized" }, 401);
		}

		const ctx: TRPCContext = {
			caller,
			resolveUserDisplayName: (subject) => deps.auth.resolveUserDisplayName(subject),
			issueSubscriptionTicket: deps.issueSubscriptionTicket,
			db: deps.db,
			dbUrl: deps.dbUrl,
			stacks: deps.stacks,
			audit: deps.audit,
			updates: deps.updates,
			webhooks: deps.webhooks,
			esc: deps.esc,
			github: deps.github,
			oidcPolicies: deps.oidcPolicies ?? null,
		};

		return fetchRequestHandler({
			endpoint: "/trpc",
			req,
			router: appRouter,
			createContext: () => ctx,
			onError({ error }) {
				if (error.code !== "UNAUTHORIZED") {
					console.error("[trpc]", error);
				}
			},
		});
	});

	return app;
}

function hasProcedureType(value: unknown): value is { _def: { type: string } } {
	if (typeof value !== "object" || value === null || !("_def" in value)) {
		return false;
	}

	const def = (value as { _def?: unknown })._def;
	return typeof def === "object" && def !== null && "type" in def;
}

function isTrpcMutationRequest(path: string): boolean {
	if (!path.startsWith("/trpc/")) {
		return false;
	}
	const procedures = appRouter._def.procedures;
	const procedurePaths = path
		.slice("/trpc/".length)
		.split(",")
		.map((part) => {
			try {
				return decodeURIComponent(part);
			} catch {
				return part;
			}
		})
		.filter(Boolean);
	return procedurePaths.some((procedurePath) => {
		if (!(procedurePath in procedures)) {
			return false;
		}

		const candidate = procedures[procedurePath as keyof typeof procedures];
		return hasProcedureType(candidate) && candidate._def.type === "mutation";
	});
}
