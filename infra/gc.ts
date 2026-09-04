import { database, databaseUrl, vpc } from "./database";
import {
	devAuthToken,
	encryptionKey,
	githubAppSecrets,
	otelEndpoint,
	otelHeaders,
	sharedSecrets,
} from "./secrets";
import { bucket } from "./storage";

const githubDeliverySecrets = githubAppSecrets
	? [githubAppSecrets.appId, githubAppSecrets.privateKey]
	: [];
const githubDeliveryEnvironment = githubAppSecrets
	? {
			PROCELLA_GITHUB_DELIVERY_APP_ID: githubAppSecrets.appId.value,
			PROCELLA_GITHUB_DELIVERY_PRIVATE_KEY: githubAppSecrets.privateKey.value,
		}
	: {};

export const gc = new sst.aws.Cron("ProcellaGcCron", {
	schedule: "rate(1 minute)",
	job: {
		runtime: "provided.al2023",
		architecture: "x86_64",
		bundle: ".build/gc",
		handler: "bootstrap",
		timeout: "60 seconds",
		memory: "256 MB",
		vpc,
		link: [database, bucket, ...sharedSecrets, ...githubDeliverySecrets],
		environment: {
			PROCELLA_DATABASE_URL: databaseUrl,
			PROCELLA_BLOB_BACKEND: "s3",
			PROCELLA_BLOB_S3_BUCKET: bucket.name,
			PROCELLA_AUTH_MODE: "dev",
			PROCELLA_DEV_AUTH_TOKEN: devAuthToken.value,
			...githubDeliveryEnvironment,
			PROCELLA_ENCRYPTION_KEY: encryptionKey.value,
			PROCELLA_OTEL_ENABLED: "true",
			OTEL_EXPORTER_OTLP_ENDPOINT: otelEndpoint.value,
			OTEL_EXPORTER_OTLP_HEADERS: otelHeaders.value,
		},
	},
});
