// @procella/server — Shared bootstrap logic for both Bun.serve and Lambda.
//
// Creates all services and the Hono app. Called once at module load time
// in both entry points (index.ts for local dev, vercel.ts for production).

import { createHash } from "node:crypto";
import { DescopeAuditService, NoopAuditService } from "@procella/audit";
import { createAuthService, DescopeAuthService } from "@procella/auth";
import { loadConfig } from "@procella/config";
import { AesCryptoService } from "@procella/crypto";
import { createDb } from "@procella/db";
import {
	LambdaEvaluatorClient,
	PostgresEscService,
	StdioEvaluatorClient,
	UnimplementedEvaluatorClient,
} from "@procella/esc";
import { buildGitHubAppConfig, OctokitGitHubService } from "@procella/github";
import {
	JwksValidatorImpl,
	OidcExchangeService,
	PostgresTrustPolicyRepository,
	type TrustPolicyRepository,
} from "@procella/oidc";
import { PostgresStacksService } from "@procella/stacks";
import { createBlobStorage } from "@procella/storage";
import { initTelemetry } from "@procella/telemetry";
import { PULUMI_FULLY_SUPPORTED_MIN_VERSION, PULUMI_LEGACY_SMOKE_VERSION } from "@procella/types";
import { PostgresUpdatesService } from "@procella/updates";
import { PostgresWebhooksService } from "@procella/webhooks";
import { logger } from "./logger.js";
import { createCliApp } from "./routes/cli.js";
import { createApp } from "./routes/index.js";
import { createWebApp } from "./routes/web.js";
import { createSubscriptionTicketService } from "./subscription-tickets.js";

const KNOWN_DEV_ENCRYPTION_KEY = createHash("sha256")
	.update("procella-dev-encryption-key")
	.digest("hex");

export function requireExplicitEncryptionKey(encryptionKey: string | undefined): string {
	if (!encryptionKey) {
		throw new Error("PROCELLA_ENCRYPTION_KEY is required");
	}
	if (encryptionKey.toLowerCase() === KNOWN_DEV_ENCRYPTION_KEY.toLowerCase()) {
		throw new Error("PROCELLA_ENCRYPTION_KEY must not use the well-known dev value");
	}
	return encryptionKey;
}

/**
 * Emit a single structured startup log stating the configured Pulumi CLI
 * compatibility support tiers (legacy smoke floor, fully supported minimum).
 * Called once from bootstrapServices() so every deployment mode (local dev,
 * Vercel/Lambda server, CLI-only, web-only) logs the same policy values.
 */
export function logCompatibilityPolicy(deltaCheckpointsEnabled: boolean): void {
	logger.info(
		{
			legacySmokeVersion: PULUMI_LEGACY_SMOKE_VERSION,
			fullySupportedMinVersion: PULUMI_FULLY_SUPPORTED_MIN_VERSION,
			deltaCheckpointsEnabled,
		},
		"pulumi-compatibility-policy",
	);
}

async function bootstrapServices() {
	const config = loadConfig();
	const encryptionKey = requireExplicitEncryptionKey(config.encryptionKey);

	initTelemetry({ enabled: config.otelEnabled, serviceName: "procella" });
	logCompatibilityPolicy(config.deltaCheckpointsEnabled);

	const { db, client } = await createDb({ url: config.databaseUrl, max: config.databasePoolMax });

	// Auth
	const authConfig =
		config.authMode === "dev"
			? {
					mode: "dev" as const,
					token: config.devAuthToken as string,
					userLogin: config.devUserLogin,
					orgLogin: config.devOrgLogin,
					users: config.devUsers,
				}
			: {
					mode: "descope" as const,
					projectId: config.descopeProjectId as string,
					managementKey: config.descopeManagementKey,
					authBaseUrl: config.descopeAuthBaseUrl,
				};
	const auth = createAuthService(authConfig);
	if (!config.ticketSigningKey) {
		throw new Error(
			"PROCELLA_TICKET_SIGNING_KEY is required (32+ chars). Generate with: bun -e \"console.log(crypto.randomBytes(32).toString('hex'))\"",
		);
	}
	const subscriptionTickets = createSubscriptionTicketService(config.ticketSigningKey);
	const oidcPolicies: TrustPolicyRepository | null = config.oidcEnabled
		? new PostgresTrustPolicyRepository(db)
		: null;
	const oidcService = oidcPolicies
		? new OidcExchangeService(new JwksValidatorImpl(), oidcPolicies, auth)
		: null;

	const storage = createBlobStorage(
		config.blobBackend === "local"
			? { backend: "local", basePath: config.blobLocalPath }
			: {
					backend: "s3",
					bucket: config.blobS3Bucket as string,
					endpoint: config.blobS3Endpoint,
					region: config.blobS3Region,
					accessKeyId: process.env.AWS_ACCESS_KEY_ID,
					secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
				},
	);

	const crypto = new AesCryptoService(encryptionKey);

	// Domain services
	const stacksService = new PostgresStacksService({ db });
	const updatesService = new PostgresUpdatesService({ db, storage, crypto });
	const auditService =
		authConfig.mode === "descope" && auth instanceof DescopeAuthService
			? new DescopeAuditService(auth.sdk)
			: new NoopAuditService();
	const webhooksService = new PostgresWebhooksService({ db });
	const githubConfig = buildGitHubAppConfig(config);
	const githubService = githubConfig
		? new OctokitGitHubService({ db, config: githubConfig })
		: null;
	const localEscEvaluatorBinary = process.env.PROCELLA_ESC_EVALUATOR_BINARY;
	const evaluatorClient = config.escEvaluatorFnName
		? new LambdaEvaluatorClient({
				functionName: config.escEvaluatorFnName,
			})
		: localEscEvaluatorBinary
			? new StdioEvaluatorClient({ binaryPath: localEscEvaluatorBinary })
			: new UnimplementedEvaluatorClient();
	const escService = new PostgresEscService({
		db,
		evaluator: evaluatorClient,
		encryptionKeyHex: encryptionKey,
	});

	return {
		auth,
		authConfig,
		audit: auditService,
		corsOrigins: config.corsOrigins,
		cronSecret: config.cronSecret,
		deltaCheckpointsEnabled: config.deltaCheckpointsEnabled,
		db,
		dbUrl: config.databaseUrl,
		client,
		config,
		stacks: stacksService,
		updates: updatesService,
		webhooks: webhooksService,
		esc: escService,
		github: githubService,
		githubWebhookSecret: githubConfig?.webhookSecret,
		issueSubscriptionTicket: (caller: import("@procella/types").Caller) =>
			subscriptionTickets.issueTicket(caller),
		oidc: oidcService,
		oidcPolicies,
		verifySubscriptionTicket: (ticket: string) => subscriptionTickets.verifyTicket(ticket),
	};
}

/** Bootstrap with all routes — local dev + Vercel. */
export async function bootstrap() {
	const services = await bootstrapServices();
	const app = createApp(services);
	return {
		app,
		auth: services.auth,
		config: services.config,
		db: services.db,
		client: services.client,
		github: services.github,
	};
}

/** Bootstrap CLI-only routes — Pulumi CLI Lambda (buffered). */
export async function bootstrapCli() {
	const services = await bootstrapServices();
	const app = createCliApp(services);
	return {
		app,
		auth: services.auth,
		config: services.config,
		db: services.db,
		client: services.client,
	};
}

/** Bootstrap Web-only routes — dashboard Lambda (streaming). */
export async function bootstrapWeb() {
	const services = await bootstrapServices();
	const app = createWebApp(services);
	return {
		app,
		auth: services.auth,
		config: services.config,
		db: services.db,
		client: services.client,
	};
}
