import { database, databaseUrl, vpc } from "./database";
import { escEvaluator } from "./esc";
import { router } from "./router";
import {
	apiSecrets,
	descopeManagementKey,
	devAuthToken,
	encryptionKey,
	githubAppId,
	githubAppPrivateKey,
	githubAppWebhookSecret,
	otelEndpoint,
	otelHeaders,
	ticketSigningKey,
} from "./secrets";
import { bucket } from "./storage";

const isProd = $app.stage === "production";
const stage = $app.stage;

const descopeOutputs = !$dev ? await import("./descope") : undefined;
const descopeProjectId = descopeOutputs?.projectId;
const descopeAuthBaseUrl = descopeOutputs?.authBaseUrl;

const appOrigin = isProd ? "https://app.procella.cloud" : `https://app.${stage}.procella.cloud`;
const rootOrigin = isProd ? "https://procella.cloud" : `https://${stage}.procella.cloud`;

// ---------------------------------------------------------------------------
// CLI API — CloudFront + Lambda Function URL with HTTP/3 (QUIC)
//
// CloudFront terminates TLS at the nearest edge (~20ms from anywhere), then
// routes to the Lambda origin over AWS’s backbone network. For the chatty
// Pulumi CLI protocol (~18 sequential requests per `pulumi up`), this saves
// 1-3s for users far from us-east-1 vs direct API Gateway.
//
// HTTP/3 (QUIC) enables 0-RTT connection resumption on repeat connections,
// eliminating TLS handshake latency after the first request.
// ---------------------------------------------------------------------------
export const api = new sst.aws.Function("ProcellaCliApi", {
	runtime: "provided.al2023",
	architecture: "x86_64",
	bundle: ".build/cli-api",
	handler: "bootstrap",
	timeout: "60 seconds",
	memory: "512 MB",
	url: {
		cors: false,
		router: {
			instance: router,
			domain: isProd ? "api.procella.cloud" : `api.${stage}.procella.cloud`,
		},
	},
	vpc,
	link: [database, bucket, escEvaluator, ...apiSecrets],
	environment: {
		PROCELLA_DATABASE_URL: databaseUrl,
		PROCELLA_BLOB_BACKEND: "s3",
		PROCELLA_BLOB_S3_BUCKET: bucket.name,
		PROCELLA_AUTH_MODE: $dev ? "dev" : "descope",
		PROCELLA_ENCRYPTION_KEY: encryptionKey.value,
		PROCELLA_TICKET_SIGNING_KEY: ticketSigningKey.value,
		PROCELLA_ESC_EVALUATOR_FN_NAME: escEvaluator.name,
		PROCELLA_CORS_ORIGINS: `${appOrigin},${rootOrigin}`,
		PROCELLA_OTEL_ENABLED: "true",
		OTEL_SERVICE_NAME: `procella-cli-${stage}`,
		OTEL_EXPORTER_OTLP_ENDPOINT: otelEndpoint.value,
		OTEL_EXPORTER_OTLP_HEADERS: otelHeaders.value,
		...($dev ? { PROCELLA_DEV_AUTH_TOKEN: devAuthToken.value } : {}),
		...(!$dev
			? {
					PROCELLA_DESCOPE_PROJECT_ID: descopeProjectId,
					PROCELLA_DESCOPE_AUTH_BASE_URL: descopeAuthBaseUrl,
					PROCELLA_DESCOPE_MANAGEMENT_KEY: descopeManagementKey.value,
					PROCELLA_GITHUB_APP_ID: githubAppId.value,
					PROCELLA_GITHUB_APP_PRIVATE_KEY: githubAppPrivateKey.value,
					PROCELLA_GITHUB_APP_WEBHOOK_SECRET: githubAppWebhookSecret.value,
				}
			: {}),
	},
});

export const migrateFn = new sst.aws.Function("ProcellaMigrate", {
	runtime: "provided.al2023",
	architecture: "x86_64",
	bundle: ".build/migrate",
	handler: "bootstrap",
	timeout: "5 minutes",
	memory: "256 MB",
	vpc,
	link: [database, devAuthToken, encryptionKey],
	environment: {
		PROCELLA_DATABASE_URL: databaseUrl,
		PROCELLA_AUTH_MODE: "dev",
		PROCELLA_DEV_AUTH_TOKEN: devAuthToken.value,
		PROCELLA_ENCRYPTION_KEY: encryptionKey.value,
		PROCELLA_BLOB_BACKEND: "s3",
		PROCELLA_BLOB_S3_BUCKET: bucket.name,
	},
});
if (!$dev) {
	const migrateCmd = $interpolate`aws lambda invoke --region ${migrateFn.nodes.function.region} --function-name ${migrateFn.name} --payload '{}' --cli-binary-format raw-in-base64-out --cli-read-timeout 360 /tmp/migrate-out-${stage}.json && cat /tmp/migrate-out-${stage}.json`;
	new command.local.Command("ProcellaMigrateRun", {
		create: migrateCmd,
		update: migrateCmd,
		triggers: [Date.now().toString()],
	});
}
