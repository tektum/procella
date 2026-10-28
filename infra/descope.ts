import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as descope from "@descope/pulumi-descope";
import { DESCOPE_OUTBOUND_CALLBACK_URL, GITHUB_OUTBOUND_APP_ID } from "@procella/config";
import {
	resolveMigrationCommandDirectory,
	resolveRepositoryDirectory,
} from "../scripts/invoke-migration-lambda";
import signUpOrInFlowJson from "./flows/sign-up-or-in.json" with { type: "json" };
import stylesJson from "./flows/styles.json" with { type: "json" };
import { descopeManagementKey, githubAppOAuthSecrets } from "./secrets";

const signUpOrInFlow = JSON.stringify(signUpOrInFlowJson);
const stylesData = JSON.stringify(stylesJson);

const isProd = $app.stage === "production";
const rootDomain = isProd ? "procella.cloud" : `${$app.stage}.procella.cloud`;

// ── Custom auth domain ──────────────────────────────────────────────────────
// Descope serves auth from auth.<rootDomain> so it can set the session/refresh
// cookies as HttpOnly first-party cookies scoped to <rootDomain>. The browser
// then sends them implicitly to app.<rootDomain> (same registrable domain) and
// the server validates the session JWT straight from the DS cookie.
//
// This CNAME is more specific than the router's `*.<rootDomain>` CloudFront
// alias record, so DNS resolves auth.* to Descope, not to our distribution.
// Descope provisions the TLS certificate automatically once the CNAME is live.
const authDomain = `auth.${rootDomain}`;
export const authBaseUrl = `https://${authDomain}`;

const zone = aws.route53.getZoneOutput({ name: "procella.cloud" });
new aws.route53.Record("DescopeAuthCname", {
	zoneId: zone.zoneId,
	name: authDomain,
	type: "CNAME",
	ttl: 300,
	records: ["cname.descope.com"],
});

// ── Provider ────────────────────────────────────────────────────────────────
const provider = new descope.Provider("DescopeProvider", {
	managementKey: descopeManagementKey.value,
});
const opts = { provider };

// ── One-time adoption of pre-1.0 resources ──────────────────────────────────
// Provider v0.3.x managed roles, permissions and JWT templates inline on the
// Project. They already exist in the long-lived stages and Descope rejects
// duplicate names, so v1.0 must import them instead of creating them. Import
// IDs are `<projectId>/<entityId>`. PR previews get a fresh project and need
// nothing here. REMOVE this block and the adopt() calls after each stage has
// deployed once: Pulumi requires `import` to be dropped after the import.
const adoption: Record<string, Record<string, string> | undefined> = {
	production: {
		userJwt: "P3BeqCifPCP0NNCQH8pKuUjcW4xM/JT3BeqCfStya8W4H7wI675GQW2Pox",
		accessKeyJwt: "P3BeqCifPCP0NNCQH8pKuUjcW4xM/JT3BeqCkmZJCHteXE4gXU8RfU4LZv",
		stacksWrite: "P3BeqCifPCP0NNCQH8pKuUjcW4xM/PERM3BeqDTRA9L8EWXPL9xNsda8Spjr",
		stacksDelete: "P3BeqCifPCP0NNCQH8pKuUjcW4xM/PERM3BeqDUVFEZR875yWRwq9FkOBZG0",
		membersManage: "P3BeqCifPCP0NNCQH8pKuUjcW4xM/PERM3BeqDQGweMCKw4Ok4rmSLUEwH7x",
		admin: "P3BeqCifPCP0NNCQH8pKuUjcW4xM/ROL3BeqDWFzmVHEaLnpl8iXrR9DNst",
		member: "P3BeqCifPCP0NNCQH8pKuUjcW4xM/ROL3BeqDPbvFrCxswdVzML9GW6zaLS",
		viewer: "P3BeqCifPCP0NNCQH8pKuUjcW4xM/ROL3BeqDSKv2jHc1Qb6xEmQuZOD4WQ",
	},
	dev: {
		userJwt: "P3CMRiPdFBrRBSeVIydUSBacruTi/JT3CMRiPqUKT6xM4eJeV2erMOAWM8",
		accessKeyJwt: "P3CMRiPdFBrRBSeVIydUSBacruTi/JT3CMRiRrFXzXoHO4AVkwW7apDD3f",
		stacksWrite: "P3CMRiPdFBrRBSeVIydUSBacruTi/PERM3CMRjBBKTj8kQbAKgJiD2nH8w3H",
		stacksDelete: "P3CMRiPdFBrRBSeVIydUSBacruTi/PERM3CMRj65gqQI8hGyoYnE9SkUabOu",
		membersManage: "P3CMRiPdFBrRBSeVIydUSBacruTi/PERM3CMRj9MjccItHCzgtrDqLUxEYwG",
		admin: "P3CMRiPdFBrRBSeVIydUSBacruTi/ROL3CMRjBXiCPmVw4PzOJB8Gg7Jjwt",
		member: "P3CMRiPdFBrRBSeVIydUSBacruTi/ROL3CMRj5XyVyfOuG2TCusa5j530z4",
		viewer: "P3CMRiPdFBrRBSeVIydUSBacruTi/ROL3CMRj9I9wTc4Pn5qQbNTD0Qceqr",
	},
};
const adopt = (key: string) => {
	const id = adoption[$app.stage]?.[key];
	return id ? { ...opts, import: id } : opts;
};

// ── JWT Templates ───────────────────────────────────────────────────────
// Descope template placeholders use {{...}} syntax. The Pulumi/Terraform
// provider requires the template to be valid JSON, so placeholders must be
// quoted as string values. Descope's backend interprets them at runtime and
// emits the actual arrays/objects in the JWT claims.
// packages/auth expects tenants as Record<string, { roles: string[] }> and
// roles as string[]. `tenant_name` carries the human-friendly tenant name.
const userJwtTemplate = JSON.stringify({
	roles: "{{user.roles}}",
	tenant_name: "{{tenant.name}}",
	tenants: "{{user.tenants}}",
});

const accessKeyJwtTemplate = JSON.stringify({
	roles: "{{accesskey.roles}}",
	tenant_name: "{{tenant.name}}",
	tenants: "{{accesskey.tenants}}",
});

// ── Project ─────────────────────────────────────────────────────────────────
// Since provider v1.0 the Project only carries name/environment/tags; every
// other aspect of the project is a standalone resource keyed by projectId.
// v1.0 protects projects from deletion by default. Previews are torn down with
// `sst remove`, so only production keeps the protection.
const project = new descope.Project(
	"Procella",
	{
		name: `procella-${$app.stage}`,
		deletionProtection: isProd,
	},
	opts,
);
const projectId = project.id;

// ── Project settings ────────────────────────────────────────────────────────
// The Descope provider requires appUrl with customDomain, and customDomain
// must be a subdomain of the appUrl domain — use the stage apex (which
// also serves the UI, see infra/site.ts) so auth.<rootDomain> qualifies.
new descope.ProjectSettings(
	"ProcellaProjectSettings",
	{ projectId, appUrl: `https://${rootDomain}`, customDomain: authDomain },
	opts,
);

// ── JWT templates ───────────────────────────────────────────────────────────
// The Procella auth service (packages/auth) requires:
//   - `dct` claim (auto-set by autoTenantClaim) for tenant detection
//   - `roles` claim for RBAC (viewer / member / admin)
//   - `tenant_name` claim for human-friendly org name (slugified at runtime)
const userJwt = new descope.JwtTemplate(
	"ProcellaUserJwt",
	{
		projectId,
		name: "Procella User",
		description: "Default JWT template for Procella users — includes tenant and role claims",
		type: "user",
		template: userJwtTemplate,
		authSchema: "default",
		autoTenantClaim: true,
	},
	adopt("userJwt"),
);
const accessKeyJwt = new descope.JwtTemplate(
	"ProcellaAccessKeyJwt",
	{
		projectId,
		name: "Procella Access Key",
		description: "Default JWT template for Procella access keys — includes tenant and role claims",
		type: "key",
		template: accessKeyJwtTemplate,
		authSchema: "default",
		autoTenantClaim: true,
	},
	adopt("accessKeyJwt"),
);

// ── Session settings ────────────────────────────────────────────────────────
// Tokens are delivered as HttpOnly cookies (never exposed to JS) via the
// custom auth domain. Cookie domain is the stage apex so app.<rootDomain>
// receives them implicitly on same-origin requests; the server falls back
// to the DS cookie when no Authorization header is present (packages/auth).
// `lax` (not `strict`) so cookies survive the OAuth redirect back from the IdP.
new descope.SessionSettings(
	"ProcellaSessionSettings",
	{
		projectId,
		userJwtTemplate: userJwt.id,
		accessKeyJwtTemplate: accessKeyJwt.id,
		sessionTokenResponseMethod: "cookies",
		refreshTokenResponseMethod: "cookies",
		sessionTokenCookieDomain: rootDomain,
		refreshTokenCookieDomain: rootDomain,
		sessionTokenCookiePolicy: "lax",
		refreshTokenCookiePolicy: "lax",
	},
	opts,
);

// ── Authorization ───────────────────────────────────────────────────────────
// Roles and permissions that map to Procella's RBAC model. The `Tenant Admin`
// role (User Admin, SSO Admin, Impersonate) is built into every Descope
// project, so it is not declared here.
const stacksWrite = new descope.Permission(
	"ProcellaPermissionStacksWrite",
	{ projectId, name: "stacks:write", description: "Create and update stacks" },
	adopt("stacksWrite"),
);
const stacksDelete = new descope.Permission(
	"ProcellaPermissionStacksDelete",
	{ projectId, name: "stacks:delete", description: "Delete stacks" },
	adopt("stacksDelete"),
);
const membersManage = new descope.Permission(
	"ProcellaPermissionMembersManage",
	{ projectId, name: "members:manage", description: "Manage org members and roles" },
	adopt("membersManage"),
);

new descope.Role(
	"ProcellaRoleAdmin",
	{
		projectId,
		name: "admin",
		description: "Full access — can create stacks, run updates, and manage org members",
		permissions: [stacksWrite.name, stacksDelete.name, membersManage.name],
	},
	adopt("admin"),
);
new descope.Role(
	"ProcellaRoleMember",
	{
		projectId,
		name: "member",
		description: "Can create and run stack updates",
		permissions: [stacksWrite.name],
	},
	adopt("member"),
);
new descope.Role(
	"ProcellaRoleViewer",
	{
		projectId,
		name: "viewer",
		description: "Read-only access to stacks and update history",
		permissions: [],
	},
	adopt("viewer"),
);

// ── Authentication methods ──────────────────────────────────────────────────
new descope.PasswordSettings(
	"ProcellaPasswordSettings",
	{
		projectId,
		minLength: 12,
		lowercase: true,
		uppercase: true,
		number: true,
		nonAlphanumeric: true,
		lock: true,
		lockAttempts: 10,
		temporaryLock: true,
		temporaryLockAttempts: 5,
		temporaryLockDuration: "15 minutes",
	},
	opts,
);
new descope.OtpSettings("ProcellaOtpSettings", { projectId }, opts);
new descope.MagiclinkSettings("ProcellaMagiclinkSettings", { projectId }, opts);
new descope.TotpSettings("ProcellaTotpSettings", { projectId }, opts);
new descope.PasskeySettings("ProcellaPasskeySettings", { projectId }, opts);
new descope.OauthSettings("ProcellaOauthSettings", { projectId }, opts);

// ── Flows and styles ────────────────────────────────────────────────────────
// Custom sign-up-or-in flow with auto tenant provisioning.
// The UI uses flowId="sign-up-or-in" (hardcoded in Login.tsx).
new descope.Flow(
	"ProcellaSignUpOrInFlow",
	{ projectId, flowId: "sign-up-or-in", data: signUpOrInFlow },
	opts,
);
new descope.Styles("ProcellaStyles", { projectId, data: stylesData }, opts);

// ── GitHub Outbound Application ─────────────────────────────────────────────
// The provisioner predates descope.OutboundApp (provider v1.0), so SST still drives
// the checked-in idempotent provisioner. The GitHub OAuth client secret is a
// deploy-time input here only: after cutover no Lambda receives it, because
// Descope owns the authorization code exchange and vaults the user token.
// Pulumi executes local commands from .sst/platform, while config evaluation
// reads source files from the SST process's repository working directory.
const commandDir = resolveMigrationCommandDirectory(process.env);
const repositoryDir = resolveRepositoryDirectory(process.env, process.cwd());
const provisionScript = "scripts/provision-descope-outbound-app.ts";
const provisionScriptHash = createHash("sha256")
	.update(readFileSync(join(repositoryDir, provisionScript)))
	.digest("hex");

if (githubAppOAuthSecrets) {
	const provisionCmd = `bun run ${provisionScript}`;
	// Every input the provisioner sends to Descope is a trigger, so rotating a
	// credential, changing the callback, or renaming the app reprovisions. The
	// OAuth credentials contribute only as a digest, so no secret value is
	// compared or retained as a plain trigger input.
	const credentialDigest = $resolve([
		githubAppOAuthSecrets.clientId.value,
		githubAppOAuthSecrets.clientSecret.value,
	]).apply(([clientId, clientSecret]) =>
		createHash("sha256").update(`${clientId}\u0000${clientSecret}`).digest("hex"),
	);
	new command.local.Command(
		"ProcellaDescopeGitHubOutboundApp",
		{
			create: provisionCmd,
			update: provisionCmd,
			dir: commandDir,
			environment: {
				PROCELLA_DESCOPE_PROJECT_ID: project.id,
				PROCELLA_DESCOPE_MANAGEMENT_KEY: descopeManagementKey.value,
				PROCELLA_GITHUB_APP_CLIENT_ID: githubAppOAuthSecrets.clientId.value,
				PROCELLA_GITHUB_APP_CLIENT_SECRET: githubAppOAuthSecrets.clientSecret.value,
				PROCELLA_GITHUB_OUTBOUND_APP_ID: GITHUB_OUTBOUND_APP_ID,
			},
			triggers: [
				provisionScriptHash,
				project.id,
				credentialDigest,
				GITHUB_OUTBOUND_APP_ID,
				DESCOPE_OUTBOUND_CALLBACK_URL,
			],
		},
		{ dependsOn: [project] },
	);
}

// ── Outputs ─────────────────────────────────────────────────────────────────
const githubOutboundAppId = GITHUB_OUTBOUND_APP_ID;

export { githubOutboundAppId, project, projectId };
