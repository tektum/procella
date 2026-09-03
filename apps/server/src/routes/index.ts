// @procella/server — Hono route registration.

import { timingSafeEqual } from "node:crypto";
import { appRouter } from "@procella/api/src/router/index.js";
import type { TRPCContext } from "@procella/api/src/trpc.js";
import type { AuditService } from "@procella/audit";
import type { AuthConfig, AuthService } from "@procella/auth";
import type { Database } from "@procella/db";
import type { EscService } from "@procella/esc";
import { type GitHubService, verifyGitHubWebhookSignature } from "@procella/github";
import type { OidcService, TrustPolicyRepository } from "@procella/oidc";
import type { StacksService } from "@procella/stacks";
import { tracingMiddleware } from "@procella/telemetry";
import { PulumiRoutes } from "@procella/types";
import { GCWorker, type UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	auditHandlers,
	checkpointHandlers,
	cryptoHandlers,
	escHandlers,
	eventHandlers,
	githubHandlers,
	healthHandlers,
	oauthHandlers,
	stackHandlers,
	stateHandlers,
	updateHandlers,
	userHandlers,
	webhookHandlers,
} from "../handlers/index.js";
import {
	apiAuth,
	auditMiddleware,
	createIpRateLimiter,
	createSecurityHeadersMiddleware,
	decompress,
	errorHandler,
	pulumiAccept,
	requestLogger,
	requireRoleMiddleware,
	updateAuth,
} from "../middleware/index.js";
import type { Env } from "../types.js";
import { authenticateTrpcCaller } from "./trpc-auth.js";

// ============================================================================
// App Factory
// ============================================================================

export function createApp(deps: {
	auth: AuthService;
	authConfig: AuthConfig;
	audit: AuditService;
	corsOrigins?: string[];
	cronSecret?: string;
	db: Database;
	dbUrl: string;
	stacks: StacksService;
	updates: UpdatesService;
	webhooks: WebhooksService;
	esc: EscService;
	github: GitHubService | null;
	githubWebhookSecret?: string;
	issueSubscriptionTicket?: (caller: import("@procella/types").Caller) => Promise<string>;
	oidc?: OidcService | null;
	oidcPolicies?: TrustPolicyRepository | null;
	verifySubscriptionTicket?: (ticket: string) => Promise<import("@procella/types").Caller>;
	deltaCheckpointsEnabled?: boolean;
}): Hono<Env> {
	const app = new Hono<Env>();
	const R = PulumiRoutes;
	const withApiDecompress = decompress();
	const withCheckpointDecompress = decompress({ maxDecompressedBytes: 100 * 1024 * 1024 });

	// Global error handler (Hono onError hook)
	app.onError(errorHandler());

	// Global middleware — the custom Descope auth domain must be allowed for
	// connect/frame so the login flow can reach it.
	const authOrigin = deps.authConfig.mode === "descope" ? deps.authConfig.authBaseUrl : undefined;
	app.use("*", createSecurityHeadersMiddleware(authOrigin ? [authOrigin] : []));
	app.use("*", tracingMiddleware());
	app.use("*", requestLogger());
	if ((deps.corsOrigins ?? []).length > 0) {
		if (deps.corsOrigins?.includes("*")) {
			// biome-ignore lint/suspicious/noConsole: intentional startup warning surfaced before serving traffic
			console.warn("[cors] PROCELLA_CORS_ORIGINS=* allows any origin; do not use in production");
		}
		app.use("*", cors({ origin: deps.corsOrigins ?? [] }));
	}
	app.use("/api/*", (c, next) => {
		if (isCheckpointPath(c.req.path)) {
			return next();
		}
		return withApiDecompress(c, next);
	});

	// Create handler instances
	const health = healthHandlers({
		db: deps.db,
		deltaCheckpointsEnabled: deps.deltaCheckpointsEnabled,
	});
	const user = userHandlers(deps.stacks);
	const stackH = stackHandlers(deps.stacks, deps.webhooks);
	const auditH = auditHandlers({ audit: deps.audit });
	const updateH = updateHandlers(deps.updates, deps.stacks, deps.webhooks, deps.github);
	const webhookH = webhookHandlers({ webhooks: deps.webhooks });
	const githubH = githubHandlers({
		github: deps.github,
		webhookSecret: deps.githubWebhookSecret,
		verifySignature: verifyGitHubWebhookSignature,
	});
	const checkpointH = checkpointHandlers(deps.updates);
	const eventH = eventHandlers(deps.updates, deps.stacks);
	const cryptoH = cryptoHandlers(deps.updates, deps.stacks);
	const stateH = stateHandlers(deps.updates, deps.stacks);
	const escH = escHandlers({
		esc: deps.esc,
		resolveUserDisplayName: (subject) => deps.auth.resolveUserDisplayName(subject),
	});

	// Middleware instances
	const withApiAuth = apiAuth(deps.auth);
	const withAudit = auditMiddleware(deps.audit);
	const withPulumiAccept = pulumiAccept();
	const withCliTokenRateLimit = createIpRateLimiter({ limit: 10 });
	const withOauthTokenRateLimit = createIpRateLimiter({ limit: 30 });
	const withSingleCryptoRateLimit = createIpRateLimiter({ limit: 1000 });
	const withBatchCryptoRateLimit = createIpRateLimiter({ limit: 10_000 });
	const withTrpcMutationRateLimit = createIpRateLimiter({
		limit: 60,
		skip: (c) => !isTrpcMutationRequest(c.req.path),
	});
	const withUpdateAuth = updateAuth(
		deps.auth,
		(updateId, token) => deps.updates.verifyLeaseToken(updateId, token),
		deps.stacks,
	);

	// ========================================================================
	// tRPC routes (/trpc/*) — SSE GET requests use short-lived signed tickets
	// ========================================================================

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

	// ========================================================================
	// Public routes (no auth)
	// ========================================================================

	app.get("/healthz", health.health);
	app.get("/api/capabilities", health.capabilities);
	app.get("/api/cli/version", health.cliVersion);

	// Vercel Cron endpoint — GC worker runs as a scheduled job.
	// Registered outside /api/* to avoid pulumiAccept + apiAuth middleware.
	// Secured via Authorization: Bearer <PROCELLA_CRON_SECRET>.
	app.get("/cron/gc", async (c) => {
		const secret = deps.cronSecret;
		const provided = c.req.header("authorization");

		if (!secret || !provided?.startsWith("Bearer ")) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const providedSecret = provided.slice("Bearer ".length);
		if (!safeEqualString(providedSecret, secret)) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const gc = new GCWorker({ db: deps.db });
		await gc.runOnce();
		return c.json({ ok: true });
	});

	// Auth config discovery — UI fetches this at runtime to determine auth mode.
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

	app.post("/api/webhooks/github", githubH.handleGitHubWebhook);

	// ========================================================================
	// Update-token authenticated routes (during active update execution)
	// These use "Authorization: update-token <lease-token>" from the CLI.
	// ========================================================================

	app.patch(
		R.patchCheckpoint.path,
		withCheckpointDecompress,
		withUpdateAuth,
		checkpointH.patchCheckpoint,
	);
	app.patch(
		R.patchCheckpointVerbatim.path,
		withCheckpointDecompress,
		withUpdateAuth,
		checkpointH.patchCheckpointVerbatim,
	);
	app.patch(
		R.patchCheckpointDelta.path,
		withUpdateAuth,
		withPulumiAccept,
		withCheckpointDecompress,
		checkpointH.patchCheckpointDelta,
	);
	app.patch(R.patchJournalEntries.path, withUpdateAuth, checkpointH.appendJournalEntries);
	app.post(R.postEngineEventBatch.path, withUpdateAuth, eventH.postEvents);
	app.post(R.renewLease.path, withUpdateAuth, eventH.renewLease);
	app.post(R.completeUpdate.path, withUpdateAuth, updateH.completeUpdate);

	// ========================================================================
	// API-token authenticated routes
	// ========================================================================

	const api = new Hono<Env>();
	api.use("*", withApiAuth);
	api.use("*", withAudit);

	// User
	api.get("/user", user.getCurrentUser);
	api.get("/user/stacks", user.getUserStacks);
	api.get("/user/organizations/:orgName", user.getOrganization);
	api.get("/orgs/:org/auditlogs", requireRoleMiddleware("admin"), auditH.queryAuditLogs);
	api.get("/orgs/:org/auditlogs/export", requireRoleMiddleware("admin"), auditH.exportAuditLogs);
	api.post("/orgs/:org/hooks", requireRoleMiddleware("admin"), webhookH.createWebhook);
	api.get("/orgs/:org/hooks", requireRoleMiddleware("admin"), webhookH.listWebhooks);
	api.get("/orgs/:org/hooks/:hookId", requireRoleMiddleware("admin"), webhookH.getWebhook);
	api.put("/orgs/:org/hooks/:hookId", requireRoleMiddleware("admin"), webhookH.updateWebhook);
	api.delete("/orgs/:org/hooks/:hookId", requireRoleMiddleware("admin"), webhookH.deleteWebhook);
	api.get(
		"/orgs/:org/hooks/:hookId/deliveries",
		requireRoleMiddleware("admin"),
		webhookH.listDeliveries,
	);
	api.post("/orgs/:org/hooks/:hookId/ping", requireRoleMiddleware("admin"), webhookH.ping);
	api.get(
		"/orgs/:org/integrations/github",
		requireRoleMiddleware("admin"),
		githubH.getInstallation,
	);
	api.delete(
		"/orgs/:org/integrations/github",
		requireRoleMiddleware("admin"),
		githubH.removeInstallation,
	);

	// Stacks (specific routes first to avoid :kind catch-all)
	api.get("/stacks", stackH.listStacks);
	api.post("/stacks/:org/:project/:stack/rename", stackH.renameStack);
	api.patch("/stacks/:org/:project/:stack/tags", stackH.updateStackTags);

	// Update lifecycle (API token)
	api.post("/stacks/:org/:project/:stack/update/:updateId", updateH.startUpdate);
	api.post("/stacks/:org/:project/:stack/update/:updateId/cancel", updateH.cancelUpdate);
	api.get("/stacks/:org/:project/:stack/update/:updateId", updateH.getUpdate);
	api.get("/stacks/:org/:project/:stack/update/:updateId/events", eventH.getUpdateEvents);
	api.get("/stacks/:org/:project/:stack/updates", updateH.getHistory);

	// State operations (API token)
	api.get("/stacks/:org/:project/:stack/export", stateH.exportStack);
	api.get("/stacks/:org/:project/:stack/export/:version", stateH.exportStack);
	api.post("/stacks/:org/:project/:stack/import", stateH.importStack);

	// Crypto (API token)
	api.post("/stacks/:org/:project/:stack/encrypt", withSingleCryptoRateLimit, cryptoH.encryptValue);
	api.post("/stacks/:org/:project/:stack/decrypt", withSingleCryptoRateLimit, cryptoH.decryptValue);
	api.post(
		"/stacks/:org/:project/:stack/batch-encrypt",
		withPulumiAccept,
		withBatchCryptoRateLimit,
		cryptoH.batchEncrypt,
	);
	api.post(
		"/stacks/:org/:project/:stack/batch-decrypt",
		withPulumiAccept,
		withBatchCryptoRateLimit,
		cryptoH.batchDecrypt,
	);
	api.post("/stacks/:org/:project/:stack/log-decryption", cryptoH.logDecryption);

	// Stack CRUD + createUpdate (:kind catch-all LAST)
	api.post("/stacks/:org/:project/:stack/:kind", updateH.createUpdate);
	api.post("/stacks/:org/:project/:stack", stackH.createStack);
	api.get("/stacks/:org/:project/:stack", stackH.getStack);
	api.delete("/stacks/:org/:project/:stack", stackH.deleteStack);
	// 2-segment stack create: POST /api/stacks/:org/:project (stack name in body)
	api.post("/stacks/:org/:project", stackH.createStack);

	// ESC (Environments, Secrets & Config)
	api.get("/esc/environments", escH.listAllEnvironments);
	api.get("/esc/environments/:org", escH.listOrgEnvironments);
	api.post("/esc/environments/:org", escH.createEnvironment);
	api.post("/esc/environments/:org/:project/:envName/clone", escH.cloneEnvironment);
	api.get("/esc/environments/:org/:project/:envName", escH.getEnvironment);
	api.get("/esc/environments/:org/:project/:envName/versions/:version", escH.getEnvironment);
	api.patch("/esc/environments/:org/:project/:envName", escH.updateEnvironment);
	api.delete("/esc/environments/:org/:project/:envName", escH.deleteEnvironment);
	api.get("/esc/environments/:org/:project/:envName/versions", escH.listRevisions);
	api.get("/esc/environments/:org/:project/:envName/versions/tags", escH.listRevisionTags);
	api.post("/esc/environments/:org/:project/:envName/versions/tags", escH.createRevisionTag);
	api.get("/esc/environments/:org/:project/:envName/versions/tags/:tagName", escH.getRevisionTag);
	api.patch(
		"/esc/environments/:org/:project/:envName/versions/tags/:tagName",
		escH.updateRevisionTag,
	);
	api.delete(
		"/esc/environments/:org/:project/:envName/versions/tags/:tagName",
		escH.deleteRevisionTag,
	);
	api.post("/esc/environments/:org/yaml/check", escH.validateYaml);
	api.post("/esc/environments/:org/:project/:envName/open", escH.openSession);
	api.get("/esc/environments/:org/:project/:envName/open/:sessionId", escH.getSession);
	api.post("/esc/environments/:org/:project/:envName/drafts", escH.createDraft);
	api.get("/esc/environments/:org/:project/:envName/drafts/:draftId", escH.getDraft);
	api.patch("/esc/environments/:org/:project/:envName/drafts/:draftId", escH.updateDraft);

	api.post("/esc/v1-internal/environments/:org/:project", escH.internalCreateEnvironment);
	api.get("/esc/v1-internal/environments/:org/:project", escH.internalListEnvironments);
	api.get("/esc/v1-internal/environments/:org/:project/:envName", escH.internalGetEnvironment);
	api.patch("/esc/v1-internal/environments/:org/:project/:envName", escH.internalUpdateEnvironment);
	api.delete(
		"/esc/v1-internal/environments/:org/:project/:envName",
		escH.internalDeleteEnvironment,
	);
	api.get(
		"/esc/v1-internal/environments/:org/:project/:envName/versions",
		escH.internalListRevisions,
	);
	api.get(
		"/esc/v1-internal/environments/:org/:project/:envName/versions/tags",
		escH.internalListRevisionTags,
	);
	api.delete(
		"/esc/v1-internal/environments/:org/:project/:envName/versions/tags/:tagName",
		escH.internalUntagRevision,
	);
	api.put(
		"/esc/v1-internal/environments/:org/:project/:envName/versions/:version/tags/:tagName",
		escH.internalTagRevision,
	);
	api.get(
		"/esc/v1-internal/environments/:org/:project/:envName/versions/:version",
		escH.internalGetRevision,
	);
	api.post("/esc/v1-internal/environments/:org/:project/:envName/open", escH.internalOpenSession);
	api.get(
		"/esc/v1-internal/environments/:org/:project/:envName/open/:sessionId",
		escH.internalGetSession,
	);
	api.get("/esc/v1-internal/environments/:org/:project/:envName/tags", escH.getEnvironmentTags);
	api.put("/esc/v1-internal/environments/:org/:project/:envName/tags", escH.setEnvironmentTags);
	api.patch(
		"/esc/v1-internal/environments/:org/:project/:envName/tags",
		escH.updateEnvironmentTags,
	);
	api.post("/esc/v1-internal/environments/:org/:project/:envName/drafts", escH.internalCreateDraft);
	api.get("/esc/v1-internal/environments/:org/:project/:envName/drafts", escH.internalListDrafts);
	api.get(
		"/esc/v1-internal/environments/:org/:project/:envName/drafts/:draftId",
		escH.internalGetDraft,
	);
	api.post(
		"/esc/v1-internal/environments/:org/:project/:envName/drafts/:draftId/apply",
		escH.applyDraft,
	);
	api.post(
		"/esc/v1-internal/environments/:org/:project/:envName/drafts/:draftId/discard",
		escH.discardDraft,
	);

	app.route("/api", api);
	return app;
}

function isCheckpointPath(path: string): boolean {
	return /\/api\/stacks\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/(checkpoint|checkpointverbatim|checkpointdelta)$/.test(
		path,
	);
}

function safeEqualString(a: string, b: string): boolean {
	const aBuf = Buffer.from(a);
	const bBuf = Buffer.from(b);
	if (aBuf.length !== bBuf.length) {
		return false;
	}
	return timingSafeEqual(aBuf, bBuf);
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
