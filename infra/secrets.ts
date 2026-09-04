export const encryptionKey = new sst.Secret("ProcellaEncryptionKey");
export const devAuthToken = new sst.Secret("ProcellaDevAuthToken");
export const descopeManagementKey = new sst.Secret("ProcellaDescopeManagementKey");
export const githubAppId = new sst.Secret("ProcellaGitHubAppId");
export const githubAppPrivateKey = new sst.Secret("ProcellaGitHubAppPrivateKey");
export const githubAppWebhookSecret = new sst.Secret("ProcellaGitHubAppWebhookSecret");
export const otelEndpoint = new sst.Secret("ProcellaOtelEndpoint");
export const otelHeaders = new sst.Secret("ProcellaOtelHeaders");
export const ticketSigningKey = new sst.Secret("ProcellaTicketSigningKey");

// sharedSecrets are linked into every Lambda. descopeManagementKey and
// ticketSigningKey are NOT included because the GC Lambda never calls Descope
// APIs and never issues/verifies tickets — so granting it those secrets would
// violate least privilege.
// cronSecret is intentionally NOT declared — the AWS deploy uses a dedicated
// gc Lambda (gc-bootstrap.ts) that calls GCWorker.runOnce() directly, so the
// HTTP /cron/gc route in createApp() is never served from this infra. The route
// remains in the codebase for Vercel/Render deploys that drive cron over HTTP.
export const sharedSecrets = [encryptionKey, devAuthToken, otelEndpoint, otelHeaders];

export const apiSecrets = [
	...sharedSecrets,
	descopeManagementKey,
	githubAppId,
	githubAppPrivateKey,
	githubAppWebhookSecret,
	ticketSigningKey,
];
