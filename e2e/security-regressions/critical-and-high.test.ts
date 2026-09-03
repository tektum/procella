import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Database } from "@procella/db";
import { Role, UnauthorizedError } from "@procella/types";
import type { Subprocess } from "bun";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { parsePort } from "../../apps/ui/src/utils/parsePort.js";
import { protectedProcedure, router, type TRPCContext } from "../../packages/api/src/trpc.js";
import { DescopeAuthService, DevAuthService, extractRoles } from "../../packages/auth/src/index.js";
import { AesCryptoService, type StackCryptoInput } from "../../packages/crypto/src/index.js";
import {
	PostgresTrustPolicyRepository,
	validateTrustPolicyClaimConditions,
} from "../../packages/oidc/src/policy.js";
import { applyTextEdits } from "../../packages/updates/src/helpers.js";
import {
	apiRequest,
	BACKEND_URL,
	ensureDeps,
	resetDatabase,
	startServer,
	stopServer,
	TEST_TOKEN_USER_B,
	truncateTables,
} from "../helpers.js";

const DESCOPE_TEST_AUDIENCE = "P3Aaha02iJvkGVbPDAF78KWuAxe6";
const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const RUN_SERVER_TESTS = process.env.PROCELLA_SECURITY_E2E === "1";
const serverTest = RUN_SERVER_TESTS ? test : test.skip;

function buildTrpcContext(overrides?: Partial<TRPCContext>): TRPCContext {
	return {
		caller: {
			tenantId: "tenant-1",
			orgSlug: "dev-org",
			userId: "user-1",
			login: "alice",
			roles: ["admin"],
			principalType: "user",
		},
		db: {} as never,
		dbUrl: "",
		stacks: {} as never,
		audit: {} as never,
		updates: {} as never,
		webhooks: {} as never,
		esc: {} as never,
		github: null,
		oidcPolicies: null,
		...overrides,
	};
}

async function updateRequest(
	path: string,
	token: string,
	opts?: { method?: string; body?: unknown },
): Promise<Response> {
	return fetch(`${BACKEND_URL}/api${path}`, {
		method: opts?.method ?? "GET",
		headers: {
			Authorization: `update-token ${token}`,
			Accept: "application/vnd.pulumi+8",
			...(opts?.body ? { "Content-Type": "application/json" } : {}),
		},
		body: opts?.body ? JSON.stringify(opts.body) : undefined,
	});
}

async function createStartedUpdate(stackPath: string, token?: string) {
	const createStackRes = await apiRequest(`/stacks/${stackPath}`, {
		method: "POST",
		token,
		body: {},
	});
	expect(createStackRes.status).toBe(200);

	const createUpdateRes = await apiRequest(`/stacks/${stackPath}/update`, {
		method: "POST",
		token,
		body: {},
	});
	expect(createUpdateRes.status).toBe(200);
	const { updateID } = (await createUpdateRes.json()) as { updateID: string };

	const startUpdateRes = await apiRequest(`/stacks/${stackPath}/update/${updateID}`, {
		method: "POST",
		token,
		body: {},
	});
	expect(startUpdateRes.status).toBe(200);
	const { token: leaseToken } = (await startUpdateRes.json()) as { token: string };

	return { updateID, leaseToken };
}

function testMasterKey(): string {
	return createHash("sha256").update("procella-dev-encryption-key").digest("hex");
}

function stackInput(overrides?: Partial<StackCryptoInput>): StackCryptoInput {
	return {
		stackId: "11111111-1111-1111-1111-111111111111",
		stackFQN: "acme/security/prod",
		...overrides,
	};
}

function reqWithAuth(authHeader: string): Request {
	return new Request("http://localhost:9090/api/test", {
		headers: { Authorization: authHeader },
	});
}

function makeDescopeSdk() {
	const loadByUserId = mock(async () => ({ ok: true, data: { email: "omer@acme.com" } }));
	const createAccessKey = mock(async () => ({ ok: true, data: { cleartext: "ak_test_token" } }));

	return {
		createAccessKey,
		loadByUserId,
		management: {
			user: {
				loadByUserId,
			},
			accessKey: {
				create: createAccessKey,
			},
		},
		sdk: {
			management: {
				user: { loadByUserId },
				accessKey: { create: createAccessKey },
			},
		} as unknown as ConstructorParameters<typeof DescopeAuthService>[0]["sdk"],
	};
}

async function createJwtHarness() {
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const publicJwk = await exportJWK(publicKey);
	publicJwk.alg = "RS256";
	publicJwk.use = "sig";
	publicJwk.kid = "descope-test-key";

	const jwks = { keys: [publicJwk] };
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === "/.well-known/jwks.json") {
				return Response.json(jwks);
			}
			return new Response("not found", { status: 404 });
		},
	});

	return {
		issuer: `http://localhost:${server.port}`,
		audience: DESCOPE_TEST_AUDIENCE,
		privateKey,
		server,
	};
}

async function signDescopeJwt(
	privateKey: Parameters<SignJWT["sign"]>[0],
	claims: Record<string, unknown>,
	options: { issuer: string; audience: string; alg?: "RS256" | "HS256"; secret?: Uint8Array },
): Promise<string> {
	const signer = new SignJWT(claims)
		.setProtectedHeader({ alg: options.alg ?? "RS256", kid: "descope-test-key" })
		.setIssuer(options.issuer)
		.setAudience(options.audience)
		.setExpirationTime("1h");

	if (options.alg === "HS256") {
		return signer.sign(options.secret ?? new TextEncoder().encode("test-secret"));
	}

	return signer.sign(privateKey);
}

function createConflictDb(): Database {
	// create() runs inside db.transaction(); the insert must reject with SQLSTATE 23505
	// so the repository maps it to OidcPolicyConflictError (policy_conflict).
	const conflictError = Object.assign(new Error("duplicate key value violates unique constraint"), {
		code: "23505",
		constraint: "idx_oidc_trust_org_issuer",
	});
	const db = {
		insert: mock(() => ({
			values: mock(() => ({
				returning: mock(() => Promise.reject(conflictError)),
			})),
		})),
		select: mock(() => ({ from: mock(() => ({ where: mock(async () => []) })) })),
		update: mock(() => ({
			set: mock(() => ({ where: mock(() => ({ returning: mock(async () => []) })) })),
		})),
		delete: mock(() => ({ where: mock(async () => undefined) })),
		transaction: mock(async (callback: (tx: unknown) => unknown) => callback(db)),
	};
	return db as unknown as Database;
}

let server: Subprocess;

beforeAll(async () => {
	if (!RUN_SERVER_TESTS) {
		return;
	}
	await ensureDeps();
	await resetDatabase();
	server = await startServer();
});

beforeEach(async () => {
	if (!RUN_SERVER_TESTS) {
		return;
	}
	await truncateTables();
});

afterAll(async () => {
	if (RUN_SERVER_TESTS && server) {
		await stopServer(server);
	}
});

describe("[security] CRITICAL regressions (vulns.txt C1-C6)", () => {
	serverTest("[C1] cross-tenant decrypt returns 404 (no zero authz)", async () => {
		// C1 exploit attempt: org-b attacker tries to decrypt dev-org ciphertext by pointing at the victim stack URL.
		const stackPath = "dev-org/security-c1/dev";
		await apiRequest(`/stacks/${stackPath}`, { method: "POST", body: {} });

		const encryptRes = await apiRequest(`/stacks/${stackPath}/encrypt`, {
			method: "POST",
			body: { plaintext: btoa("tenant-a-secret") },
		});
		expect(encryptRes.status).toBe(200);
		const { ciphertext } = (await encryptRes.json()) as { ciphertext: string };

		const decryptRes = await apiRequest(`/stacks/${stackPath}/decrypt`, {
			method: "POST",
			token: TEST_TOKEN_USER_B,
			body: { ciphertext },
		});

		expect(decryptRes.status).toBe(404);
		expect(await decryptRes.json()).toEqual({ code: "stack_not_found" });
	});

	serverTest("[C2] lease token replay against different stack URL returns 403", async () => {
		// C2 exploit attempt: replay an attacker lease token against a victim stack URL and expect URL/stack binding rejection.
		const attackerStack = "dev-org/security-c2/attacker";
		const victimStack = "org-b/security-c2-victim/victim";
		const { updateID, leaseToken } = await createStartedUpdate(attackerStack);
		await apiRequest(`/stacks/${victimStack}`, {
			method: "POST",
			token: TEST_TOKEN_USER_B,
			body: {},
		});

		const completeRes = await updateRequest(
			`/stacks/${victimStack}/update/${updateID}/complete`,
			leaseToken,
			{
				method: "POST",
				body: { status: "succeeded" },
			},
		);

		expect(completeRes.status).toBe(403);
		expect(await completeRes.json()).toEqual({
			code: "lease_url_mismatch",
			message: "Lease token does not match URL stack",
		});
	});

	test("[C3] tRPC protectedProcedure rejects unauthenticated callers", async () => {
		// C3 exploit attempt: invoke a protected tRPC procedure without ctx.caller and require an UNAUTHORIZED failure.
		const source = await Bun.file(
			new URL("../../packages/api/src/trpc.ts", import.meta.url),
		).text();
		expect(source).toContain("export const protectedProcedure");

		const testRouter = router({
			whoami: protectedProcedure.query(({ ctx }) => ctx.caller.tenantId),
		});

		const caller = testRouter.createCaller(buildTrpcContext({ caller: null }));
		expect(caller.whoami()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: "Authentication required",
		});
	});

	serverTest("[C4] invalid update kind returns 400", async () => {
		// C4 exploit attempt: POST a script-like update kind and verify the handler rejects it before any persistence.
		// encodeURIComponent is required: a literal `/` inside `</script>` becomes an extra path segment (404).
		const kind = encodeURIComponent("<script>alert(1)</script>");
		const res = await apiRequest(`/stacks/dev-org/security-c4/dev/${kind}`, {
			method: "POST",
			body: {},
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			code: "invalid_kind",
			message: "Invalid update kind: <script>alert(1)</script>",
		});
	});

	test("[C5] CliLogin parsePort rejects URL userinfo attack (port=1234@evil)", () => {
		// C5 exploit attempt: smuggle an attacker host via URL userinfo syntax in the `port` query parameter.
		expect(parsePort("1234@evil.com")).toBeNull();
		expect(parsePort("1234")).toBe(1234);
	});

	test("[C6] HKDF v2 ciphertext survives stack rename (stackId-derived salt)", async () => {
		// C6 exploit attempt: change only the stack FQN and ensure v2 ciphertext still decrypts because the key is stackId-bound.
		const crypto = new AesCryptoService(testMasterKey());
		const plaintext = new TextEncoder().encode("rename-safe secret");
		const beforeRename = stackInput();
		const afterRename = stackInput({ stackFQN: "acme/security/prod-renamed" });

		const ciphertext = await crypto.encrypt(beforeRename, plaintext);
		expect(crypto.decrypt(afterRename, ciphertext)).resolves.toEqual(plaintext);
	});
});

describe("[security] HIGH regressions (vulns.txt H1-H9)", () => {
	test("[H1] dev token compare uses timingSafeEqual", async () => {
		// H1 exploit attempt: rely on structural proof plus runtime auth failures so dev token checks stay constant-time and reject mismatches.
		const source = await Bun.file(
			new URL("../../packages/auth/src/index.ts", import.meta.url),
		).text();
		expect(source).toContain('import { timingSafeEqual } from "node:crypto"');
		expect(source).toMatch(
			/function safeEqualString\(a: string, b: string\): boolean \{[\s\S]*timingSafeEqual\(Buffer\.from\(a\), Buffer\.from\(b\)\)/,
		);

		const svc = new DevAuthService({
			token: "devtoken123",
			userLogin: "dev-user",
			orgLogin: "dev-org",
		});

		expect(svc.authenticate(reqWithAuth("token wrong-token"))).rejects.toBeInstanceOf(
			UnauthorizedError,
		);
		expect(svc.authenticate(reqWithAuth("token bad"))).rejects.toBeInstanceOf(UnauthorizedError);
	});

	serverTest("[H2] tRPC subscription rejects without ticket", async () => {
		// H2 exploit attempt: hit the SSE subscription endpoint without a signed ticket and expect 401 before any query-string auth shortcut is accepted.
		const res = await fetch(
			`${BACKEND_URL}/trpc/updates.onEvents?input=%7B%22org%22%3A%22dev-org%22%2C%22project%22%3A%22security-h2%22%2C%22stack%22%3A%22dev%22%2C%22updateId%22%3A%22upd-1%22%7D`,
		);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ code: 401, message: "Unauthorized" });
	});

	test("[H3] JWT validation enforces alg/iss/aud allowlists", async () => {
		// H3 exploit attempt: try JWTs with wrong algorithm, issuer, and audience; each must fail verification.
		const harness = await createJwtHarness();
		const descope = makeDescopeSdk();
		const svc = new DescopeAuthService({
			sdk: descope.sdk,
			config: { projectId: harness.audience, issuer: harness.issuer },
		});

		try {
			const claims = {
				sub: "user-1",
				dct: "tenant-1",
				tenants: { "tenant-1": { roles: ["admin"] } },
				exp: Math.floor(Date.now() / 1000) + 3600,
			};

			const wrongAlg = await signDescopeJwt(harness.privateKey, claims, {
				issuer: harness.issuer,
				audience: harness.audience,
				alg: "HS256",
				secret: new TextEncoder().encode("wrong-secret"),
			});
			const wrongIssuer = await signDescopeJwt(harness.privateKey, claims, {
				issuer: `${harness.issuer}/wrong`,
				audience: harness.audience,
			});
			const wrongAudience = await signDescopeJwt(harness.privateKey, claims, {
				issuer: harness.issuer,
				audience: `${harness.audience}-wrong`,
			});

			expect(svc.authenticate(reqWithAuth(`Bearer ${wrongAlg}`))).rejects.toThrow();
			expect(svc.authenticate(reqWithAuth(`Bearer ${wrongIssuer}`))).rejects.toThrow();
			expect(svc.authenticate(reqWithAuth(`Bearer ${wrongAudience}`))).rejects.toThrow();
		} finally {
			svc.dispose();
			harness.server.stop();
		}
	});

	test("[H4] createCliAccessKey strips dct/tenants/roles from customClaims", async () => {
		// H4 exploit attempt: inject tenant/role claims into CLI key minting and verify the allowlist strips them.
		const sdk = makeDescopeSdk();
		const svc = new DescopeAuthService({
			sdk: sdk.sdk,
			config: { projectId: DESCOPE_TEST_AUDIENCE },
		});

		try {
			await svc.createCliAccessKey(
				{
					tenantId: "tenant-1",
					orgSlug: "my-org",
					userId: "user-1",
					login: "omer",
					roles: ["admin"],
					principalType: "user",
				},
				"security-h4",
				{
					expireTime: 3600,
					customClaims: {
						dct: "tenant-2",
						tenants: { "tenant-2": { roles: ["admin"] } },
						roles: ["admin"],
						procellaLogin: "attacker-override",
						procellaOrgSlug: "attacker-org",
					},
				},
			);

			expect(sdk.createAccessKey).toHaveBeenCalledTimes(1);
			const createAccessKeyCall = sdk.createAccessKey.mock.calls[0] as unknown as
				| unknown[]
				| undefined;
			const customClaimsArg = createAccessKeyCall?.[5];
			if (!customClaimsArg || typeof customClaimsArg !== "object") {
				throw new Error("customClaims payload was not passed to accessKey.create");
			}
			const customClaims = customClaimsArg as Record<string, unknown>;

			expect(customClaims.procellaLogin).toBe("omer@acme.com");
			expect(customClaims.procellaOrgSlug).toBe("my-org");
			expect(customClaims.dct).toBeUndefined();
			expect(customClaims.tenants).toBeUndefined();
			expect(customClaims.roles).toBeUndefined();
		} finally {
			svc.dispose();
		}
	});

	test("[H5] extractRoles returns [] when tenant entry missing (no top-level fallback)", () => {
		// H5 exploit attempt: supply top-level roles without a matching tenant record and verify tenant authz stays empty.
		expect(
			extractRoles(
				{
					dct: "tenant-1",
					roles: ["admin"],
					tenants: { "tenant-2": { roles: ["viewer"] } },
				},
				"tenant-1",
			),
		).toEqual([]);
	});

	test("[H6] OIDC trust policy create with conflicting (org_slug, issuer) fails with policy_conflict", async () => {
		// H6 exploit attempt: tenant-2 tries to create the same (org_slug, issuer) tuple and must get a policy_conflict instead of deleting another tenant's policy.
		const repo = new PostgresTrustPolicyRepository(createConflictDb());

		expect(
			repo.create({
				tenantId: "tenant-2",
				orgSlug: "acme",
				provider: "github-actions",
				displayName: "Conflicting Policy",
				issuer: GITHUB_ACTIONS_ISSUER,
				maxExpiration: 3600,
				claimConditions: {
					iss: GITHUB_ACTIONS_ISSUER,
					repository_owner: "myorg",
				},
				grantedRole: Role.Member,
				active: true,
			}),
		).rejects.toMatchObject({
			code: "policy_conflict",
			message: "OIDC trust policy with this org/issuer pair already exists",
		});
	});

	test("[H7] OIDC claimConditions with single broad claim is rejected", () => {
		// H7 exploit attempt: register an issuer-only trust policy that would authorize every GitHub Actions workflow on Earth.
		expect(() =>
			validateTrustPolicyClaimConditions({
				provider: "github-actions",
				issuer: GITHUB_ACTIONS_ISSUER,
				claimConditions: { iss: GITHUB_ACTIONS_ISSUER },
			}),
		).toThrow("OIDC trust policy must require at least two claim conditions");
	});

	serverTest("[H8] checkpoint body without zod schema fields returns 400", async () => {
		// H8 exploit attempt: PATCH /checkpoint with a malformed body and require schema validation to reject it with 400.
		const stackPath = "dev-org/security-h8/dev";
		const { updateID, leaseToken } = await createStartedUpdate(stackPath);

		const res = await updateRequest(
			`/stacks/${stackPath}/update/${updateID}/checkpoint`,
			leaseToken,
			{
				method: "PATCH",
				body: { sequenceNumber: 1, unexpected: true },
			},
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("invalid_request");
		expect(body.message).toContain("version");
	});

	test("[H9] applyTextEdits rejects out-of-bounds spans", () => {
		// H9 exploit attempt: replace the whole checkpoint JSON with an out-of-bounds span and require BadRequest rejection.
		expect(() =>
			applyTextEdits(new TextEncoder().encode("abcdef"), [
				{
					span: {
						start: { line: 0, column: 0, offset: 2 },
						end: { line: 0, column: 0, offset: 99 },
					},
					newText: "X",
				},
			]),
		).toThrow("TextEdit span is out of bounds");
	});
});
