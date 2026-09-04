// E2E — OIDC CI authentication: trust policy setup, token exchange, pulumi login.
//
// This test spins up a mock OIDC provider (Bun.serve with an RS256 keypair),
// configures a trust policy via the tRPC API, then runs `pulumi login --oidc-token`
// to verify the full exchange flow works end-to-end.
//
// NOTE: Requires PROCELLA_OIDC_ENABLED=true in the server environment.
// The server must be started with Descope auth for OIDC exchange to work.
// In CI this test is only run when PROCELLA_DESCOPE_PROJECT_ID is set.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { BACKEND_URL, cleanupDir, createPulumiHome, pulumi, truncateTables } from "./helpers.js";

// Skip this test suite if OIDC e2e is not configured.
// Dev mode auth cannot mint Descope access keys so exchange will fail.
const SKIP =
	(process.env.PROCELLA_OIDC_ENABLED !== "true" && process.env.PROCELLA_OIDC_ENABLED !== "1") ||
	process.env.PROCELLA_AUTH_MODE === "dev";

const describe_oidc = SKIP ? describe.skip : describe;

// ============================================================================
// Mock OIDC Provider
// ============================================================================

interface MockIssuer {
	url: string;
	privateKey: CryptoKey;
	server: ReturnType<typeof Bun.serve>;
	stop(): void;
}

async function startMockIssuer(): Promise<MockIssuer> {
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const publicJwk = await exportJWK(publicKey);
	publicJwk.kid = "test-key-1";
	publicJwk.alg = "RS256";
	publicJwk.use = "sig";

	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/.well-known/openid-configuration") {
				return Response.json({
					issuer: `http://localhost:${server.port}`,
					jwks_uri: `http://localhost:${server.port}/.well-known/jwks.json`,
				});
			}
			if (url.pathname === "/.well-known/jwks.json" || url.pathname === "/.well-known/jwks") {
				return Response.json({ keys: [publicJwk] });
			}
			return new Response("Not Found", { status: 404 });
		},
	});

	const url = `http://localhost:${server.port}`;
	return { url, privateKey, server, stop: () => server.stop() };
}

async function signJwt(
	issuer: MockIssuer,
	audience: string,
	claims: Record<string, unknown>,
): Promise<string> {
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
		.setIssuedAt()
		.setExpirationTime("5m")
		.setIssuer(issuer.url)
		.setAudience(audience)
		.setSubject("repo:acme/infra:ref:refs/heads/main")
		.sign(issuer.privateKey);
}

// ============================================================================
// tRPC API helpers (no PulumiAccept header, uses Bearer token)
// ============================================================================

async function trpcRequest(procedure: string, input: unknown, token: string): Promise<unknown> {
	const body = JSON.stringify({ "0": { json: input } });
	const res = await fetch(`${BACKEND_URL}/trpc/${procedure}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
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

// ============================================================================
// Tests
// ============================================================================

describe_oidc("OIDC CI authentication", () => {
	let issuer: MockIssuer;
	let pulumiHome: string;
	let adminToken: string;

	beforeAll(async () => {
		issuer = await startMockIssuer();
		pulumiHome = await createPulumiHome();
		// Admin token from env (Descope access key with admin role)
		adminToken = process.env.PROCELLA_E2E_ADMIN_TOKEN ?? "";
		if (!adminToken) throw new Error("PROCELLA_E2E_ADMIN_TOKEN required for OIDC e2e tests");
	});

	afterAll(async () => {
		issuer.stop();
		await cleanupDir(pulumiHome);
		await truncateTables();
	});

	test("create trust policy via tRPC", async () => {
		const policy = (await trpcRequest(
			"oidc.createPolicy",
			{
				provider: "github-actions",
				displayName: "E2E Test Policy",
				issuer: issuer.url,
				maxExpiration: 3600,
				claimConditions: {
					repository_owner_id: "99999",
					repository_id: "11111",
				},
				grantedRole: "member",
			},
			adminToken,
		)) as { id: string; displayName: string };

		expect(policy.id).toBeString();
		expect(policy.displayName).toBe("E2E Test Policy");
	});

	test("exchange OIDC token returns access_token", async () => {
		const audience = "urn:pulumi:org:dev-org";
		const jwt = await signJwt(issuer, audience, {
			repository_owner_id: "99999",
			repository_id: "11111",
			repository: "acme/infra",
			ref: "refs/heads/main",
			actor: "octocat",
			actor_id: "1234567",
			run_id: "9876543",
		});

		const body = new URLSearchParams({
			audience,
			grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
			subject_token: jwt,
			subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
			requested_token_type: "urn:pulumi:token-type:access_token:organization",
			expiration: "3600",
		});

		const res = await fetch(`${BACKEND_URL}/api/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			access_token: string;
			issued_token_type: string;
			token_type: string;
			expires_in: number;
		};
		expect(data.access_token).toBeString();
		expect(data.access_token.length).toBeGreaterThan(10);
		expect(data.issued_token_type).toBe("urn:pulumi:token-type:access_token:organization");
		expect(data.expires_in).toBeLessThanOrEqual(3600);
	});

	test("pulumi login with OIDC token succeeds", async () => {
		const audience = "urn:pulumi:org:dev-org";
		const jwt = await signJwt(issuer, audience, {
			repository_owner_id: "99999",
			repository: "acme/infra",
			actor: "octocat",
		});

		const result = await pulumi(
			["login", "--oidc-token", jwt, "--oidc-org", "dev-org", BACKEND_URL],
			{ pulumiHome },
		);

		expect(result.exitCode).toBe(0);
	});

	test("wrong audience is rejected with access_denied", async () => {
		const jwt = await signJwt(issuer, "urn:pulumi:org:wrong-org", {
			repository_owner_id: "99999",
		});

		const body = new URLSearchParams({
			audience: "urn:pulumi:org:wrong-org",
			grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
			subject_token: jwt,
			subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
			requested_token_type: "urn:pulumi:token-type:access_token:organization",
		});

		const res = await fetch(`${BACKEND_URL}/api/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		expect(res.status).toBe(403);
		const data = (await res.json()) as { error: string };
		expect(data.error).toBe("access_denied");
	});

	test("claim mismatch is rejected with access_denied", async () => {
		const audience = "urn:pulumi:org:dev-org";
		// Wrong repository_owner_id — policy requires "99999"
		const jwt = await signJwt(issuer, audience, {
			repository_owner_id: "00000",
			repository: "other/repo",
		});

		const body = new URLSearchParams({
			audience,
			grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
			subject_token: jwt,
			subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
			requested_token_type: "urn:pulumi:token-type:access_token:organization",
		});

		const res = await fetch(`${BACKEND_URL}/api/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		expect(res.status).toBe(403);
		const data = (await res.json()) as { error: string };
		expect(data.error).toBe("access_denied");
	});
});
