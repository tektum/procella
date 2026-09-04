// Web API Lambda — tRPC dashboard routes + SSE subscriptions.
//
// Served from the same CloudFront distribution as the static site (app. domain)
// via ordered cache behaviors in infra/site.ts. Streaming enabled for SSE.

import { database, databaseUrl, vpc } from "./database";
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

const stage = $app.stage;
const descopeOutputs = !$dev ? await import("./descope") : undefined;
const descopeProjectId = descopeOutputs?.projectId;
const descopeAuthBaseUrl = descopeOutputs?.authBaseUrl;

export const webApi = new sst.aws.Function("ProcellaWebApi", {
	runtime: "provided.al2023",
	architecture: "x86_64",
	bundle: ".build/web-api",
	handler: "bootstrap",
	streaming: true,
	url: {
		cors: false,
	},
	timeout: "60 seconds",
	memory: "512 MB",
	vpc,
	link: [database, bucket, ...apiSecrets],
	environment: {
		PROCELLA_DATABASE_URL: databaseUrl,
		PROCELLA_BLOB_BACKEND: "s3",
		PROCELLA_BLOB_S3_BUCKET: bucket.name,
		PROCELLA_AUTH_MODE: $dev ? "dev" : "descope",
		PROCELLA_ENCRYPTION_KEY: encryptionKey.value,
		PROCELLA_TICKET_SIGNING_KEY: ticketSigningKey.value,
		PROCELLA_OTEL_ENABLED: "true",
		OTEL_SERVICE_NAME: `procella-web-${stage}`,
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
