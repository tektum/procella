// @procella/server — CLI-only route factory for Pulumi CLI API.
//
// Mounts /api/* routes (stack CRUD, update lifecycle, checkpoints, crypto, state)
// with API-token and update-token auth. No tRPC, no CORS, no SSE.

import type { AuditService } from "@procella/audit";
import type { AuthConfig, AuthService } from "@procella/auth";
import type { Database } from "@procella/db";
import type { EscService } from "@procella/esc";
import { type GitHubService, verifyGitHubWebhookSignature } from "@procella/github";
import type { OidcService } from "@procella/oidc";
import type { StacksService } from "@procella/stacks";
import { tracingMiddleware } from "@procella/telemetry";
import { PulumiRoutes } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import { Hono } from "hono";
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

export interface CliAppDeps {
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
	githubWebhookSecret?: string;
	oidc?: OidcService | null;
	deltaCheckpointsEnabled?: boolean;
}

export function createCliApp(deps: CliAppDeps): Hono<Env> {
	const app = new Hono<Env>();
	const R = PulumiRoutes;
	const withApiDecompress = decompress();
	const withCheckpointDecompress = decompress({ maxDecompressedBytes: 100 * 1024 * 1024 });

	app.onError(errorHandler());

	// Global middleware — no CORS (CLI traffic only)
	app.use("*", createSecurityHeadersMiddleware());
	app.use("*", tracingMiddleware());
	app.use("*", requestLogger());
	app.use("/api/*", (c, next) => {
		if (isCheckpointPath(c.req.path)) {
			return next();
		}
		return withApiDecompress(c, next);
	});

	// Handler instances
	const health = healthHandlers({
		db: deps.db,
		deltaCheckpointsEnabled: deps.deltaCheckpointsEnabled,
	});
	const user = userHandlers(deps.stacks);
	const stackH = stackHandlers(deps.stacks, deps.webhooks);
	const auditH = auditHandlers({ audit: deps.audit });
	const updateH = updateHandlers(deps.updates, deps.stacks, deps.webhooks);
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
	const withOauthTokenRateLimit = createIpRateLimiter({ limit: 30 });
	const withSingleCryptoRateLimit = createIpRateLimiter({ limit: 1000 });
	const withBatchCryptoRateLimit = createIpRateLimiter({ limit: 10_000 });
	const withUpdateAuth = updateAuth(
		deps.auth,
		(updateId, token) => deps.updates.verifyLeaseToken(updateId, token),
		deps.stacks,
	);

	// Public routes
	app.get("/healthz", health.health);
	app.get("/api/capabilities", health.capabilities);
	app.get("/api/cli/version", health.cliVersion);

	// GitHub webhook (no auth — verified by signature)
	app.post("/api/webhooks/github", githubH.handleGitHubWebhook);

	const oauth = oauthHandlers(deps.oidc ?? null);
	app.post("/api/oauth/token", withOauthTokenRateLimit, oauth.tokenExchange);

	// Update-token authenticated routes (during active update execution)
	// Auth runs before decompress so unauthenticated requests are rejected before
	// expensive gzip/JSON processing (defense-in-depth against decompression bombs).
	app.patch(
		R.patchCheckpoint.path,
		withUpdateAuth,
		withCheckpointDecompress,
		checkpointH.patchCheckpoint,
	);
	app.patch(
		R.patchCheckpointVerbatim.path,
		withUpdateAuth,
		withCheckpointDecompress,
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

	// API-token authenticated routes
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

	// Stacks
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

	// ESC internal dashboard routes
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
