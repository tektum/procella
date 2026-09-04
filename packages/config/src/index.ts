// @procella/config — Environment configuration with Zod validation.
//
// All configuration is sourced from environment variables (PROCELLA_* prefix).
// Zod schemas validate and parse at startup — fail fast on misconfiguration.
// Uses process.env for portability across Bun, Node.js, and Vercel.

import { z } from "zod";

const roleSchema = z.enum(["admin", "member", "viewer"]);
const devUserSchema = z.object({
	token: z.string().min(1),
	login: z.string().min(1),
	org: z.string().min(1),
	role: roleSchema.default("admin"),
});

// ============================================================================
// Schema
// ============================================================================

const authModeSchema = z.enum(["dev", "descope"]);
const blobBackendSchema = z.enum(["local", "s3"]);

const configSchema = z
	.object({
		// Server
		listenAddr: z.string().default(":9090"),

		// Database
		databaseUrl: z.string().url(),
		databasePoolMax: z.coerce.number().int().min(1).max(100).default(10),

		// Auth
		authMode: authModeSchema,
		devAuthToken: z.string().optional(),
		devUserLogin: z.string().default("dev-user"),
		devOrgLogin: z.string().default("dev-org"),
		devUsers: z
			.string()
			.optional()
			.transform((value, ctx) => {
				if (!value) return [];
				try {
					return z.array(devUserSchema).parse(JSON.parse(value));
				} catch (error) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message:
							error instanceof Error
								? `Invalid PROCELLA_DEV_USERS: ${error.message}`
								: "Invalid PROCELLA_DEV_USERS",
					});
					return z.NEVER;
				}
			}),
		descopeProjectId: z.string().optional(),
		descopeManagementKey: z.string().optional(),
		descopeAuthBaseUrl: z.string().url().optional(),
		ticketSigningKey: z.string().min(32, "Must be at least 32 characters").optional(),

		// Blob storage
		blobBackend: blobBackendSchema.default("local"),
		blobLocalPath: z.string().default("./data/blobs"),
		blobS3Bucket: z.string().optional(),
		blobS3Endpoint: z.string().url().optional(),
		blobS3Region: z.string().default("us-east-1"),

		// Encryption
		encryptionKey: z
			.string()
			.regex(/^[0-9a-fA-F]{64}$/, "Must be 64 hex chars (32 bytes)")
			.optional(),
		cronSecret: z.string().min(1).optional(),

		// Telemetry
		otelEnabled: z
			.enum(["true", "false", "1", "0"])
			.default("false")
			.transform((v) => v === "true" || v === "1"),

		oidcEnabled: z
			.enum(["true", "false", "1", "0"])
			.default("true")
			.transform((v) => v === "true" || v === "1"),

		// Pulumi compatibility — delta checkpoint capability advertisement
		deltaCheckpointsEnabled: z
			.enum(["true", "false", "1", "0"])
			.default("false")
			.transform((v) => v === "true" || v === "1"),

		githubAppId: z.string().regex(/^\d+$/, "Must be a numeric GitHub App ID").optional(),
		githubAppSlug: z
			.string()
			.regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/, "Must be a valid GitHub App slug")
			.optional(),
		githubAppPrivateKey: z
			.string()
			.transform((key) => key.replace(/\\n/g, "\n"))
			.optional(),
		githubAppWebhookSecret: z.string().optional(),

		// ESC
		escEvaluatorFnName: z.string().optional(),

		// CORS
		corsOrigins: z
			.string()
			.transform((s) =>
				s
					.split(",")
					.map((o) => o.trim())
					.filter(Boolean),
			)
			.optional(),
	})
	.superRefine((data, ctx) => {
		if (data.authMode === "dev" && !data.devAuthToken) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Required when PROCELLA_AUTH_MODE=dev",
				path: ["devAuthToken"],
			});
		}
		if (data.authMode === "descope" && !data.descopeProjectId) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Required when PROCELLA_AUTH_MODE=descope",
				path: ["descopeProjectId"],
			});
		}
		if (data.blobBackend === "s3" && !data.blobS3Bucket) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Required when PROCELLA_BLOB_BACKEND=s3",
				path: ["blobS3Bucket"],
			});
		}
		// OIDC enabled by default; dev mode silently disables it in bootstrap

		const githubFields = [
			data.githubAppId,
			data.githubAppSlug,
			data.githubAppPrivateKey,
			data.githubAppWebhookSecret,
		];
		const githubProvided = githubFields.filter((value) => Boolean(value)).length;
		if (githubProvided > 0 && githubProvided < githubFields.length) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"GitHub App integration requires PROCELLA_GITHUB_APP_ID, PROCELLA_GITHUB_APP_SLUG, PROCELLA_GITHUB_APP_PRIVATE_KEY, and PROCELLA_GITHUB_APP_WEBHOOK_SECRET together.",
				path: ["githubAppId"],
			});
		}
	});

// ============================================================================
// Types
// ============================================================================

export type Config = z.infer<typeof configSchema>;
export type AuthMode = z.infer<typeof authModeSchema>;
export type BlobBackend = z.infer<typeof blobBackendSchema>;

// ============================================================================
// Loader
// ============================================================================

const envMapping = {
	listenAddr: "PROCELLA_LISTEN_ADDR",
	databaseUrl: "PROCELLA_DATABASE_URL",
	databasePoolMax: "PROCELLA_DATABASE_POOL_MAX",
	authMode: "PROCELLA_AUTH_MODE",
	devAuthToken: "PROCELLA_DEV_AUTH_TOKEN",
	devUserLogin: "PROCELLA_DEV_USER_LOGIN",
	devOrgLogin: "PROCELLA_DEV_ORG_LOGIN",
	devUsers: "PROCELLA_DEV_USERS",
	descopeProjectId: "PROCELLA_DESCOPE_PROJECT_ID",
	descopeManagementKey: "PROCELLA_DESCOPE_MANAGEMENT_KEY",
	descopeAuthBaseUrl: "PROCELLA_DESCOPE_AUTH_BASE_URL",
	ticketSigningKey: "PROCELLA_TICKET_SIGNING_KEY",
	blobBackend: "PROCELLA_BLOB_BACKEND",
	blobLocalPath: "PROCELLA_BLOB_LOCAL_PATH",
	blobS3Bucket: "PROCELLA_BLOB_S3_BUCKET",
	blobS3Endpoint: "PROCELLA_BLOB_S3_ENDPOINT",
	blobS3Region: "PROCELLA_BLOB_S3_REGION",
	encryptionKey: "PROCELLA_ENCRYPTION_KEY",
	cronSecret: "PROCELLA_CRON_SECRET",
	otelEnabled: "PROCELLA_OTEL_ENABLED",
	oidcEnabled: "PROCELLA_OIDC_ENABLED",
	deltaCheckpointsEnabled: "PROCELLA_DELTA_CHECKPOINTS_ENABLED",
	githubAppId: "PROCELLA_GITHUB_APP_ID",
	githubAppSlug: "PROCELLA_GITHUB_APP_SLUG",
	githubAppPrivateKey: "PROCELLA_GITHUB_APP_PRIVATE_KEY",
	githubAppWebhookSecret: "PROCELLA_GITHUB_APP_WEBHOOK_SECRET",
	escEvaluatorFnName: "PROCELLA_ESC_EVALUATOR_FN_NAME",
	corsOrigins: "PROCELLA_CORS_ORIGINS",
} as const;

function envToConfig(): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, envVar] of Object.entries(envMapping)) {
		result[key] = process.env[envVar];
	}
	// PaaS platforms (Railway, Render, Heroku) inject PORT.
	// Fall back to PORT when PROCELLA_LISTEN_ADDR is not set.
	if (!result.listenAddr && process.env.PORT) {
		const port = process.env.PORT.replace(/^:/, "").trim();
		if (/^\d+$/.test(port)) {
			result.listenAddr = `:${port}`;
		}
	}
	return result;
}

/**
 * Load and validate configuration from environment variables.
 * Throws a ZodError on validation failure — call at startup.
 */
export function loadConfig(): Config {
	return configSchema.parse(envToConfig());
}

/**
 * Load config, returning a result tuple instead of throwing.
 * Useful for CLI tools that want to display errors nicely.
 */
export function tryLoadConfig(): { ok: true; config: Config } | { ok: false; error: z.ZodError } {
	const result = configSchema.safeParse(envToConfig());
	if (result.success) {
		return { ok: true, config: result.data };
	}
	return { ok: false, error: result.error };
}

/**
 * Format a ZodError into human-readable config error messages.
 * Maps camelCase config keys to their PROCELLA_* env var names.
 */
export function formatConfigErrors(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const key = issue.path.join(".");
			const envVar = envMapping[key as keyof typeof envMapping];
			const label = envVar ? `${envVar}` : key;
			return `  ✗ ${label}: ${issue.message}`;
		})
		.join("\n");
}
