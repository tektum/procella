// E2E — Descope auth + OIDC against a real deployed preview environment.
//
// Runs against the deployed preview (not a local server). Tests real Descope
// auth with management SDK test users, and real GitHub Actions OIDC tokens
// for the OIDC exchange flow. Zero mocks.
//
// Run via: bun run e2e:descope
//
// Required env vars (injected by preview.yml integration-tests job):
//   PROCELLA_API_URL                 — Deployed preview API URL (e.g. https://api.pr-42.procella.cloud)
//   PROCELLA_DESCOPE_PROJECT_ID      — Ephemeral Descope project ID from SST deploy
//   PROCELLA_DESCOPE_MANAGEMENT_KEY  — Descope management key (GitHub secret)
//
// Optional:
//   PROCELLA_E2E_ORG_SLUG            — Org slug for OIDC audience (defaults to preview tenant name)
//   ACTIONS_ID_TOKEN_REQUEST_URL     — GitHub Actions OIDC endpoint (set automatically in CI)
//   ACTIONS_ID_TOKEN_REQUEST_TOKEN   — GitHub Actions OIDC token (set automatically in CI)
//
// Auto-skipped when required env vars are absent (local dev, fork PRs).

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import DescopeClient from "@descope/node-sdk";
import { cleanupDir, createPulumiHome, pulumi } from "./helpers.js";

// ============================================================================
// Configuration
// ============================================================================

const API_URL = process.env.PROCELLA_API_URL ?? "";
// tRPC routes (/trpc/*) are on the app subdomain in deployed preview,
// falling back to API_URL for local dev where both are on the same port.
const APP_URL = process.env.PROCELLA_APP_URL ?? API_URL;
const DESCOPE_PROJECT_ID = process.env.PROCELLA_DESCOPE_PROJECT_ID ?? "";
const DESCOPE_MANAGEMENT_KEY = process.env.PROCELLA_DESCOPE_MANAGEMENT_KEY ?? "";

const SKIP = !API_URL || !DESCOPE_PROJECT_ID || !DESCOPE_MANAGEMENT_KEY;
const describe_descope = SKIP ? describe.skip : describe;

// GitHub Actions OIDC — available when job has `permissions: id-token: write`
const OIDC_REQUEST_URL = process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "";
const OIDC_REQUEST_TOKEN = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "";
const HAS_OIDC = Boolean(OIDC_REQUEST_URL && OIDC_REQUEST_TOKEN);

const RUN_ID = Date.now().toString(36);
const TEST_LOGIN_ID = `procella-e2e-${RUN_ID}@test.invalid`;

// ============================================================================
// Helpers
// ============================================================================

/** Create a Descope test user with admin role and return a short-lived access key. */
async function setupTestUser(
	sdk: ReturnType<typeof DescopeClient>,
	tenantId: string,
	orgSlug: string,
): Promise<string> {
	await sdk.management.user.createTestUser(TEST_LOGIN_ID, {
		email: TEST_LOGIN_ID,
		verifiedEmail: true,
		displayName: "Procella E2E Test User",
		userTenants: [{ tenantId, roleNames: ["admin"] }],
	});

	const expireTime = Math.floor(Date.now() / 1000) + 600;
	const resp = await sdk.management.accessKey.create(
		`procella-e2e-${RUN_ID}`,
		expireTime,
		null,
		[{ tenantId, roleNames: ["admin"] }],
		undefined,
		{ procellaOrgSlug: orgSlug },
	);

	if (!resp.data?.cleartext) {
		throw new Error("Descope accessKey.create returned no cleartext");
	}
	return resp.data.cleartext;
}

/** Request a real GitHub Actions OIDC token with a custom audience. */
async function getGitHubOidcToken(audience: string): Promise<string> {
	const url = `${OIDC_REQUEST_URL}&audience=${encodeURIComponent(audience)}`;
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${OIDC_REQUEST_TOKEN}` },
	});
	if (!res.ok) {
		throw new Error(`Failed to get GitHub OIDC token: ${res.status} ${await res.text()}`);
	}
	const data = (await res.json()) as { value: string };
	return data.value;
}

/** Call a tRPC mutation on the deployed API. */
async function trpcMutation(procedure: string, input: unknown, token: string): Promise<unknown> {
	// tRPC v11 POST mutation without batching: body is {"json": input}
	const body = JSON.stringify({ json: input });
	const res = await fetch(`${APP_URL}/trpc/${procedure}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `token ${token}`,
		},
		body,
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`tRPC ${procedure} failed (${res.status}): ${text}`);
	}
	const json = (await res.json()) as { result?: { data?: { json?: unknown } } }[];
	return json[0]?.result?.data?.json;
}

async function trpcQuery(procedure: string, headers: Record<string, string>): Promise<unknown> {
	const url = `${APP_URL}/trpc/${procedure}?batch=1&input=${encodeURIComponent(
		JSON.stringify({ 0: { json: null, meta: { values: ["undefined"], v: 1 } } }),
	)}`;
	const res = await fetch(url, { headers });
	if (!res.ok) {
		throw new Error(`tRPC ${procedure} failed (${res.status}): ${await res.text()}`);
	}
	const json = (await res.json()) as { result?: { data?: { json?: unknown } } }[];
	return json[0]?.result?.data?.json;
}

interface DesiredOidcPolicy {
	provider: "github-actions";
	displayName: string;
	issuer: string;
	maxExpiration: number;
	claimConditions: Record<string, string>;
	grantedRole: "viewer" | "member" | "admin";
}

interface OidcPolicyUpdate extends Omit<DesiredOidcPolicy, "provider" | "issuer"> {
	id: string;
	active: boolean;
}

interface OidcPolicyAdmin {
	list(): Promise<unknown>;
	create(policy: DesiredOidcPolicy): Promise<unknown>;
	update(policy: OidcPolicyUpdate): Promise<unknown>;
}

function findExistingPolicyId(policies: unknown, issuer: string): string | undefined {
	if (!Array.isArray(policies)) {
		throw new Error("oidc.listPolicies returned an invalid response");
	}

	const matches: string[] = [];
	for (const candidate of policies) {
		if (
			typeof candidate === "object" &&
			candidate !== null &&
			"issuer" in candidate &&
			candidate.issuer === issuer &&
			"id" in candidate &&
			typeof candidate.id === "string"
		) {
			matches.push(candidate.id);
		}
	}
	if (matches.length > 1) {
		throw new Error(`Multiple OIDC policies use issuer ${issuer}: ${matches.join(", ")}`);
	}
	return matches[0];
}

async function reconcileOidcPolicy(
	admin: OidcPolicyAdmin,
	desired: DesiredOidcPolicy,
): Promise<"created" | "updated"> {
	let existingPolicyId = findExistingPolicyId(await admin.list(), desired.issuer);
	if (!existingPolicyId) {
		try {
			await admin.create(desired);
			return "created";
		} catch (error) {
			const isOwnershipConflict =
				error instanceof Error &&
				error.message.includes("(409)") &&
				error.message.includes("OIDC trust policy with this org/issuer pair already exists");
			if (!isOwnershipConflict) throw error;

			existingPolicyId = findExistingPolicyId(await admin.list(), desired.issuer);
			if (!existingPolicyId) throw error;
		}
	}

	await admin.update({
		id: existingPolicyId,
		displayName: desired.displayName,
		maxExpiration: desired.maxExpiration,
		claimConditions: desired.claimConditions,
		grantedRole: desired.grantedRole,
		active: true,
	});
	return "updated";
}

const testOidcPolicy: DesiredOidcPolicy = {
	provider: "github-actions",
	displayName: "E2E GitHub OIDC",
	issuer: "https://token.actions.githubusercontent.com",
	maxExpiration: 600,
	claimConditions: { repository_owner_id: "12345", repository_id: "67890" },
	grantedRole: "member",
};

describe("OIDC policy reconciliation", () => {
	test("updates the tenant-listed policy with the configured issuer", async () => {
		const create = mock(async () => undefined);
		const update = mock(async () => undefined);
		const result = await reconcileOidcPolicy(
			{
				list: mock(async () => [
					{ id: "other", issuer: "https://issuer.example.com" },
					{ id: "github", issuer: testOidcPolicy.issuer, active: false },
				]),
				create,
				update,
			},
			testOidcPolicy,
		);

		expect(result).toBe("updated");
		expect(create).not.toHaveBeenCalled();
		expect(update).toHaveBeenCalledWith({
			id: "github",
			displayName: testOidcPolicy.displayName,
			maxExpiration: testOidcPolicy.maxExpiration,
			claimConditions: testOidcPolicy.claimConditions,
			grantedRole: testOidcPolicy.grantedRole,
			active: true,
		});
	});

	test("re-lists and updates after a concurrent ownership conflict", async () => {
		const list = mock(async () =>
			list.mock.calls.length === 1 ? [] : [{ id: "winner", issuer: testOidcPolicy.issuer }],
		);
		const update = mock(async () => undefined);
		const result = await reconcileOidcPolicy(
			{
				list,
				create: mock(async () => {
					throw new Error(
						"tRPC oidc.createPolicy failed (409): OIDC trust policy with this org/issuer pair already exists",
					);
				}),
				update,
			},
			testOidcPolicy,
		);

		expect(result).toBe("updated");
		expect(list).toHaveBeenCalledTimes(2);
		expect(update).toHaveBeenCalledTimes(1);
	});

	test("fails closed when stale ownership is not visible to the current tenant", async () => {
		const list = mock(async () => []);
		const update = mock(async () => undefined);

		await expect(
			reconcileOidcPolicy(
				{
					list,
					create: mock(async () => {
						throw new Error(
							"tRPC oidc.createPolicy failed (409): OIDC trust policy with this org/issuer pair already exists",
						);
					}),
					update,
				},
				testOidcPolicy,
			),
		).rejects.toThrow("OIDC trust policy with this org/issuer pair already exists");
		expect(list).toHaveBeenCalledTimes(2);
		expect(update).not.toHaveBeenCalled();
	});

	test("rejects ambiguous same-issuer policies before updating", async () => {
		const update = mock(async () => undefined);
		await expect(
			reconcileOidcPolicy(
				{
					list: mock(async () => [
						{ id: "first", issuer: testOidcPolicy.issuer, active: false },
						{ id: "second", issuer: testOidcPolicy.issuer, active: true },
					]),
					create: mock(async () => undefined),
					update,
				},
				testOidcPolicy,
			),
		).rejects.toThrow("Multiple OIDC policies use issuer");
		expect(update).not.toHaveBeenCalled();
	});

	test("does not recover unrelated create conflicts", async () => {
		await expect(
			reconcileOidcPolicy(
				{
					list: mock(async () => []),
					create: mock(async () => {
						throw new Error("tRPC oidc.createPolicy failed (409): display name conflict");
					}),
					update: mock(async () => undefined),
				},
				testOidcPolicy,
			),
		).rejects.toThrow("display name conflict");
	});
});

// ============================================================================
// Tests
// ============================================================================

describe_descope("Descope auth (deployed preview)", () => {
	let sdk: ReturnType<typeof DescopeClient>;
	let accessKey: string;
	let pulumiHome: string;
	let orgSlug: string;
	let tenantId: string;
	let createdTenant = false; // track if we created the tenant (for cleanup)

	beforeAll(async () => {
		// Verify the preview API is reachable before attempting any tests.
		// This catches infrastructure drift (e.g. CloudFront destroyed by killed cleanup)
		// and fails fast with a clear message instead of cryptic ConnectionRefused errors.
		const healthUrl = `${API_URL}/healthz`;
		let healthy = false;
		for (let attempt = 1; attempt <= 10; attempt++) {
			try {
				const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
				if (res.ok) {
					healthy = true;
					break;
				}
			} catch {}
			await Bun.sleep(3000);
		}
		if (!healthy) {
			throw new Error(
				`Preview API unreachable after 10 attempts (30s): ${healthUrl}\n` +
					"This usually means the CloudFront router was destroyed by a cancelled cleanup. " +
					"Re-run the full Preview Environment workflow to trigger drift recovery.",
			);
		}

		sdk = DescopeClient({
			projectId: DESCOPE_PROJECT_ID,
			managementKey: DESCOPE_MANAGEMENT_KEY,
		});

		// Use PROCELLA_E2E_ORG_SLUG if given, otherwise derive a stable tenant
		// name from the deployed preview stage. Descope tenant IDs are generated
		// inside each project, so recreating the project can assign a new ID to the
		// same name. The migration Lambda resets only explicitly enabled
		// `procella_pr_N` databases before replaying migrations, preventing policy
		// rows owned by an earlier project tenant from crossing that boundary.
		// Normal policy APIs remain tenant-scoped and never take over those rows.
		// API_URL is `https://api.pr-NN.procella.cloud`. Extract the `pr-NN`
		// segment as the stage; the Descope project name (and therefore the
		// JWT-emitted `tenant_name` → slugified `orgSlug`) is `procella-${stage}`.
		const stageMatch = API_URL.match(/api\.(pr-\d+)\./);
		const derivedTenantName = stageMatch ? `procella-${stageMatch[1]}` : undefined;
		const tenantName = process.env.PROCELLA_E2E_ORG_SLUG ?? derivedTenantName ?? `e2e-${RUN_ID}`;
		orgSlug = tenantName;

		// Find or create the Descope tenant for this test run.
		const tenantsResp = await sdk.management.tenant.loadAll();
		const existing = tenantsResp.data?.find((t) => t.name === tenantName);
		if (existing?.id) {
			tenantId = existing.id;
		} else {
			// Keep the preview stage tenant for later test runs. Only the explicit
			// per-run fallback tenant is removed during cleanup.
			// create() signature: (name, selfProvisioningDomains[], ...)
			const created = await sdk.management.tenant.create(tenantName, []);
			const createdId = created.data?.id;
			if (!createdId)
				throw new Error(
					`Failed to create Descope tenant '${tenantName}': ${JSON.stringify(created)}`,
				);
			tenantId = createdId;
			createdTenant = tenantName.startsWith("e2e-");
		}

		await sdk.management.user.deleteAllTestUsers().catch(() => {});
		accessKey = await setupTestUser(sdk, tenantId, orgSlug);
		pulumiHome = await createPulumiHome();

		// Discover the orgSlug the server actually derives from this access key's
		// JWT (`extractOrgSlug` in packages/auth: tenant_name claim → slugify, with
		// fallback to nested tenants[].name → tenantId).
		//
		// We use the server's authoritative view as both the policy `orgSlug`
		// (created via tRPC, which writes `ctx.caller.orgSlug`) AND the OIDC
		// exchange `audience` ("urn:pulumi:org:<slug>"). If we hard-coded the
		// Descope tenant `name` here, drift in JWT templates across ephemeral
		// preview projects (e.g. an older project missing `accessKeyJwtTemplate`
		// binding) would write a policy under one slug and look it up under
		// another, producing a confusing 403 "Token exchange not available".
		const userRes = await fetch(`${API_URL}/api/user`, {
			headers: {
				Authorization: `token ${accessKey}`,
				Accept: "application/vnd.pulumi+8",
			},
		});
		if (!userRes.ok) {
			throw new Error(`GET /api/user failed (${userRes.status}): ${await userRes.text()}`);
		}
		const userBody = (await userRes.json()) as {
			organizations?: { githubLogin?: string }[];
		};
		const serverOrgSlug = userBody.organizations?.[0]?.githubLogin;
		if (!serverOrgSlug) {
			throw new Error(
				`/api/user response did not include organizations[0].githubLogin: ${JSON.stringify(userBody)}`,
			);
		}
		orgSlug = serverOrgSlug;
	});

	afterAll(async () => {
		await sdk?.management.user.deleteAllTestUsers().catch(() => {});
		// Clean up ephemeral tenant if we created it
		if (createdTenant && tenantId) {
			await sdk?.management.tenant.delete(tenantId).catch(() => {});
		}
		if (pulumiHome) await cleanupDir(pulumiHome);
	});

	// --- Descope access key auth ---

	test("valid Descope access key is accepted", async () => {
		const res = await fetch(`${API_URL}/api/user`, {
			headers: {
				Authorization: `token ${accessKey}`,
				Accept: "application/vnd.pulumi+8",
			},
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(typeof body.name).toBe("string");
		expect(body.organizations).toEqual([{ githubLogin: orgSlug, name: orgSlug }]);
	});

	test("invalid token is rejected", async () => {
		const res = await fetch(`${API_URL}/api/user`, {
			headers: {
				Authorization: "token not-a-real-key",
				Accept: "application/vnd.pulumi+8",
			},
		});
		expect(res.status).toBe(401);
	});

	test("dashboard tRPC accepts a Descope session JWT in a cookie", async () => {
		const exchange = await sdk.accessKey.exchange(accessKey);
		expect(exchange.ok).toBe(true);
		expect(exchange.data?.sessionJwt).toStartWith("eyJ");

		const result = await trpcQuery("stacks.list", { Cookie: `DS=${exchange.data?.sessionJwt}` });
		expect(result).toHaveProperty("stacks");
	});

	// --- Pulumi CLI ---

	test("pulumi login with access key succeeds", async () => {
		const result = await pulumi(["login", API_URL], {
			pulumiHome,
			env: { PULUMI_ACCESS_TOKEN: accessKey },
		});
		expect(result.exitCode).toBe(0);
	});

	// --- Stack CRUD ---

	test("stack create / get / delete", async () => {
		const headers = {
			Authorization: `token ${accessKey}`,
			Accept: "application/vnd.pulumi+8",
		};
		const base = `${API_URL}/api/stacks/${orgSlug}/descope-e2e-${RUN_ID}/main`;

		const create = await fetch(base, { method: "POST", headers });
		expect(create.status).toBe(200);

		const get = await fetch(base, { headers });
		expect(get.status).toBe(200);
		const stack = (await get.json()) as Record<string, unknown>;
		expect(stack.stackName).toBe("main");

		const del = await fetch(base, { method: "DELETE", headers });
		expect([200, 204]).toContain(del.status);
	});

	// --- OIDC (real GitHub Actions token) ---

	const describe_oidc = HAS_OIDC ? describe : describe.skip;

	describe_oidc("OIDC CI auth (real GitHub OIDC)", () => {
		beforeAll(async () => {
			const repositoryOwnerId = process.env.GITHUB_REPOSITORY_OWNER_ID;
			const repositoryId = process.env.GITHUB_REPOSITORY_ID;
			if (!repositoryOwnerId || !repositoryId) {
				throw new Error("GitHub repository numeric IDs are required for the OIDC E2E test");
			}

			const desired: DesiredOidcPolicy = {
				provider: "github-actions",
				displayName: `E2E GitHub OIDC (${RUN_ID})`,
				issuer: "https://token.actions.githubusercontent.com",
				maxExpiration: 600,
				claimConditions: {
					repository_owner_id: repositoryOwnerId,
					repository_id: repositoryId,
				},
				grantedRole: "member",
			};
			await reconcileOidcPolicy(
				{
					list: () => trpcQuery("oidc.listPolicies", { Authorization: `token ${accessKey}` }),
					create: (policy) => trpcMutation("oidc.createPolicy", policy, accessKey),
					update: (policy) => trpcMutation("oidc.updatePolicy", policy, accessKey),
				},
				desired,
			);
		});

		test("exchange real GitHub OIDC token", async () => {
			const audience = `urn:pulumi:org:${orgSlug}`;
			const jwt = await getGitHubOidcToken(audience);

			const body = new URLSearchParams({
				audience,
				grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
				subject_token: jwt,
				subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
				requested_token_type: "urn:pulumi:token-type:access_token:organization",
				expiration: "300",
			});

			// Retry once for Lambda cold-start 502s
			let res = await fetch(`${API_URL}/api/oauth/token`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: body.toString(),
			});
			if (res.status === 502 || res.status === 503) {
				await Bun.sleep(2000);
				res = await fetch(`${API_URL}/api/oauth/token`, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: body.toString(),
				});
			}
			if (!res.ok) {
				const errBody = await res.text();
				throw new Error(`Exchange failed (${res.status}): ${errBody}`);
			}
			expect(res.status).toBe(200);
			const data = (await res.json()) as {
				access_token: string;
				issued_token_type: string;
				expires_in: number;
			};
			expect(data.access_token).toBeString();
			expect(data.access_token.length).toBeGreaterThan(10);
			expect(data.issued_token_type).toBe("urn:pulumi:token-type:access_token:organization");
		});

		test("pulumi login --oidc-token with real GitHub OIDC token", async () => {
			const audience = `urn:pulumi:org:${orgSlug}`;
			const jwt = await getGitHubOidcToken(audience);

			// Unset PULUMI_ACCESS_TOKEN — CLI refuses to do OIDC exchange if it's set
			const result = await pulumi(["login", "--oidc-token", jwt, "--oidc-org", orgSlug, API_URL], {
				pulumiHome,
				env: { PULUMI_ACCESS_TOKEN: "", PULUMI_BACKEND_URL: "" },
			});
			if (result.exitCode !== 0) {
				throw new Error(
					`pulumi login failed (${result.exitCode}): ${result.stderr}${result.stdout}`,
				);
			}
			expect(result.exitCode).toBe(0);
		});

		test("wrong audience is rejected", async () => {
			const jwt = await getGitHubOidcToken("urn:pulumi:org:nonexistent-org");

			const body = new URLSearchParams({
				audience: "urn:pulumi:org:nonexistent-org",
				grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
				subject_token: jwt,
				subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
				requested_token_type: "urn:pulumi:token-type:access_token:organization",
			});

			const res = await fetch(`${API_URL}/api/oauth/token`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: body.toString(),
			});

			expect(res.status).toBe(403);
		});
	});
});
