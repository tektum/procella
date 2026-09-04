import { describe, expect, mock, test } from "bun:test";
import {
	AUDIENCE_PREFIX,
	DEFAULT_EXCHANGE_EXPIRATION,
	GRANT_TYPE_TOKEN_EXCHANGE,
	OidcClaims,
	REQUESTED_TOKEN_TYPE_ORG,
	SUBJECT_TOKEN_TYPE_ID_TOKEN,
} from "./claims.js";
import { OidcExchangeError, OidcExchangeService } from "./exchange.js";
import { JwksValidationError } from "./jwks.js";
import type {
	JwksValidator,
	OidcTrustPolicy,
	TokenExchangeRequest,
	TrustPolicyRepository,
} from "./types.js";

function mockPolicy(overrides: Partial<OidcTrustPolicy> = {}): OidcTrustPolicy {
	return {
		id: "policy-1",
		tenantId: "tenant-1",
		orgSlug: "acme",
		provider: "github-actions",
		displayName: "Test Policy",
		issuer: "https://token.actions.githubusercontent.com",
		maxExpiration: 7200,
		claimConditions: { sub: "repo:acme/procella", repository: "acme/procella" },
		grantedRole: "member",
		active: true,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		...overrides,
	};
}

function validRequest(overrides: Partial<TokenExchangeRequest> = {}): TokenExchangeRequest {
	return {
		audience: `${AUDIENCE_PREFIX}acme`,
		grantType: GRANT_TYPE_TOKEN_EXCHANGE,
		subjectToken:
			"eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL3Rva2VuLmFjdGlvbnMuZ2l0aHVidXNlcmNvbnRlbnQuY29tIiwic3ViIjoicmVwbzphY21lL3Byb2NlbGxhIiwiYXVkIjoidXJuOnB1bHVtaTpvcmc6YWNtZSJ9.mock-sig",
		subjectTokenType: SUBJECT_TOKEN_TYPE_ID_TOKEN,
		requestedTokenType: REQUESTED_TOKEN_TYPE_ORG,
		scope: "",
		expiration: 3600,
		...overrides,
	};
}

type TokenMinter = ConstructorParameters<typeof OidcExchangeService>[2];
type TrustPolicyRepositoryMock = TrustPolicyRepository & {
	findByOrgSlugAndIssuer: (...args: unknown[]) => Promise<OidcTrustPolicy[]>;
};

function makeAuth(createCliAccessKey?: TokenMinter["createCliAccessKey"]): TokenMinter {
	return {
		createCliAccessKey,
	};
}

async function expectExchangeError(
	promise: Promise<unknown>,
	expected: { error: string; statusCode?: number },
): Promise<void> {
	try {
		await promise;
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(OidcExchangeError);
		const exchangeErr = error as OidcExchangeError;
		expect(exchangeErr.error).toBe(expected.error);
		if (expected.statusCode !== undefined) {
			expect(exchangeErr.statusCode).toBe(expected.statusCode);
		}
	}
}

describe("OidcExchangeService", () => {
	test("happy path: valid JWT + matching policy returns token exchange response", async () => {
		const verify = mock(async () => {
			if (verify.mock.calls.length === 1) {
				throw new JwksValidationError("claim_validation_failed", "issuer mismatch");
			}
			return {
				sub: "repo:acme/procella",
				repository: "acme/procella",
				environment: "prod",
				repository_owner: "acme",
				repository_owner_id: 12345,
			};
		});
		const jwks: JwksValidator = { verify, dispose: mock(() => {}) };
		const findByOrgSlugAndIssuer = mock(async () => [
			mockPolicy({ id: "p1" }),
			mockPolicy({ id: "p2" }),
		]);
		const policies: TrustPolicyRepositoryMock = {
			findByOrgSlugAndIssuer,
			listByOrgSlug: mock(async () => []),
			create: mock(async () => mockPolicy()),
			update: mock(async () => mockPolicy()),
			delete: mock(async () => {}),
		};
		const createCliAccessKey = mock(
			async (_caller: unknown, _name: string, _opts?: { expireTime?: number }) =>
				"descope-cleartext-key",
		);
		const auth = makeAuth(createCliAccessKey);

		const service = new OidcExchangeService(jwks, policies, auth);
		const result = await service.exchange(validRequest());

		expect(result).toEqual({
			access_token: "descope-cleartext-key",
			issued_token_type: REQUESTED_TOKEN_TYPE_ORG,
			token_type: "Bearer",
			expires_in: 3600,
			scope: "",
		});
		expect(verify).toHaveBeenCalledTimes(2);
		expect(findByOrgSlugAndIssuer).toHaveBeenCalledTimes(1);
		expect(createCliAccessKey).toHaveBeenCalledTimes(1);
	});

	test("wrong grant_type throws unsupported_grant_type", async () => {
		const service = new OidcExchangeService(
			{ verify: mock(async () => ({})), dispose: mock(() => {}) },
			{
				findByOrgSlugAndIssuer: mock(async () => []),
				listByOrgSlug: mock(async () => []),
				create: mock(async () => mockPolicy()),
				update: mock(async () => mockPolicy()),
				delete: mock(async () => {}),
			} as TrustPolicyRepositoryMock,
			makeAuth(mock(async () => "x")),
		);

		await expectExchangeError(service.exchange(validRequest({ grantType: "authorization_code" })), {
			error: "unsupported_grant_type",
		});
	});

	test("wrong subject_token_type throws invalid_request", async () => {
		const service = new OidcExchangeService(
			{ verify: mock(async () => ({})), dispose: mock(() => {}) },
			{
				findByOrgSlugAndIssuer: mock(async () => []),
				listByOrgSlug: mock(async () => []),
				create: mock(async () => mockPolicy()),
				update: mock(async () => mockPolicy()),
				delete: mock(async () => {}),
			} as TrustPolicyRepositoryMock,
			makeAuth(mock(async () => "x")),
		);

		await expectExchangeError(
			service.exchange(
				validRequest({ subjectTokenType: "urn:ietf:params:oauth:token-type:access_token" }),
			),
			{ error: "invalid_request" },
		);
	});

	test("unsupported requested_token_type throws invalid_request", async () => {
		const service = new OidcExchangeService(
			{ verify: mock(async () => ({})), dispose: mock(() => {}) },
			{
				findByOrgSlugAndIssuer: mock(async () => []),
				listByOrgSlug: mock(async () => []),
				create: mock(async () => mockPolicy()),
				update: mock(async () => mockPolicy()),
				delete: mock(async () => {}),
			} as TrustPolicyRepositoryMock,
			makeAuth(mock(async () => "x")),
		);

		await expectExchangeError(
			service.exchange(
				validRequest({
					requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
				}),
			),
			{ error: "invalid_request" },
		);
	});

	test("invalid audience format throws invalid_target", async () => {
		const service = new OidcExchangeService(
			{ verify: mock(async () => ({})), dispose: mock(() => {}) },
			{
				findByOrgSlugAndIssuer: mock(async () => []),
				listByOrgSlug: mock(async () => []),
				create: mock(async () => mockPolicy()),
				update: mock(async () => mockPolicy()),
				delete: mock(async () => {}),
			} as TrustPolicyRepositoryMock,
			makeAuth(mock(async () => "x")),
		);

		await expectExchangeError(service.exchange(validRequest({ audience: "not-an-oidc-aud" })), {
			error: "invalid_target",
		});
	});

	test("no policies for org throws access_denied 403", async () => {
		const service = new OidcExchangeService(
			{ verify: mock(async () => ({})), dispose: mock(() => {}) },
			{
				findByOrgSlugAndIssuer: mock(async () => []),
				listByOrgSlug: mock(async () => []),
				create: mock(async () => mockPolicy()),
				update: mock(async () => mockPolicy()),
				delete: mock(async () => {}),
			} as TrustPolicyRepositoryMock,
			makeAuth(mock(async () => "x")),
		);

		await expectExchangeError(service.exchange(validRequest()), {
			error: "access_denied",
			statusCode: 403,
		});
	});

	test("JWT valid but no policy matches claims throws access_denied 403", async () => {
		const service = new OidcExchangeService(
			{
				verify: mock(async () => ({
					sub: "repo:acme/other",
					repository: "acme/procella",
					repository_owner_id: 99999,
				})),
				dispose: mock(() => {}),
			},
			{
				findByOrgSlugAndIssuer: mock(async () => [mockPolicy()]),
				listByOrgSlug: mock(async () => []),
				create: mock(async () => mockPolicy()),
				update: mock(async () => mockPolicy()),
				delete: mock(async () => {}),
			} as TrustPolicyRepositoryMock,
			makeAuth(mock(async () => "x")),
		);

		await expectExchangeError(service.exchange(validRequest()), {
			error: "access_denied",
			statusCode: 403,
		});
	});

	test("rejects legacy ambiguous policies before JWT verification", async () => {
		const verify = mock(async () => ({}));
		const createCliAccessKey = mock(async () => "unexpected-token");
		const service = new OidcExchangeService(
			{ verify, dispose: mock(() => {}) },
			{
				findByOrgSlugAndIssuer: mock(async () => [
					mockPolicy({ tenantId: "tenant-1", active: false }),
					mockPolicy({ tenantId: "tenant-2", active: true }),
				]),
				listByOrgSlug: mock(async () => []),
				create: mock(async () => mockPolicy()),
				update: mock(async () => mockPolicy()),
				delete: mock(async () => {}),
			} as TrustPolicyRepositoryMock,
			makeAuth(createCliAccessKey),
		);

		await expectExchangeError(service.exchange(validRequest()), {
			error: "access_denied",
			statusCode: 403,
		});
		expect(verify).not.toHaveBeenCalled();
		expect(createCliAccessKey).not.toHaveBeenCalled();
	});

	test("rejects if subject_token has no parseable iss claim", () => {
		const service = new OidcExchangeService(
			{ verify: mock(async () => ({})), dispose: mock(() => {}) },
			{
				findByOrgSlugAndIssuer: mock(async () => []),
				listByOrgSlug: mock(async () => []),
				create: mock(async () => mockPolicy()),
				update: mock(async () => mockPolicy()),
				delete: mock(async () => {}),
			} as TrustPolicyRepositoryMock,
			makeAuth(),
		);
		return expect(service.exchange(validRequest({ subjectToken: "not-a-jwt" }))).rejects.toThrow(
			"missing issuer",
		);
	});

	test("JWT verification fails across policies throws access_denied", async () => {
		const service = new OidcExchangeService(
			{
				verify: mock(async () => {
					throw new JwksValidationError("signature_invalid", "invalid signature");
				}),
				dispose: mock(() => {}),
			},
			{
				findByOrgSlugAndIssuer: mock(async () => [
					mockPolicy({ id: "p1" }),
					mockPolicy({ id: "p2" }),
				]),
				listByOrgSlug: mock(async () => []),
				create: mock(async () => mockPolicy()),
				update: mock(async () => mockPolicy()),
				delete: mock(async () => {}),
			} as TrustPolicyRepositoryMock,
			makeAuth(mock(async () => "x")),
		);

		await expectExchangeError(service.exchange(validRequest()), {
			error: "access_denied",
		});
	});

	test("expiration is capped to policy maxExpiration", async () => {
		const createCliAccessKey = mock(
			async (
				_caller: unknown,
				_name: string,
				_opts?: { expireTime?: number; customClaims?: Record<string, unknown> },
			) => "key",
		);
		const service = new OidcExchangeService(
			{
				verify: mock(async () => ({
					sub: "repo:acme/procella",
					repository: "acme/procella",
				})),
				dispose: mock(() => {}),
			},
			{
				findByOrgSlugAndIssuer: mock(async () => [mockPolicy({ maxExpiration: 900 })]),
				listByOrgSlug: mock(async () => []),
				create: mock(async () => mockPolicy()),
				update: mock(async () => mockPolicy()),
				delete: mock(async () => {}),
			} as TrustPolicyRepositoryMock,
			makeAuth(createCliAccessKey),
		);

		const now = Math.floor(Date.now() / 1000);
		const res = await service.exchange(validRequest({ expiration: 7200 }));
		expect(res.expires_in).toBe(900);

		const call = createCliAccessKey.mock.calls[0];
		expect(call).toBeDefined();
		const opts = call?.[2] as { expireTime?: number } | undefined;
		expect(opts?.expireTime).toBeGreaterThanOrEqual(now + 899);
		expect(opts?.expireTime).toBeLessThanOrEqual(now + 901);
	});

	test("missing expiration uses DEFAULT_EXCHANGE_EXPIRATION", async () => {
		const service = new OidcExchangeService(
			{
				verify: mock(async () => ({
					sub: "repo:acme/procella",
					repository: "acme/procella",
				})),
				dispose: mock(() => {}),
			},
			{
				findByOrgSlugAndIssuer: mock(async () => [mockPolicy({ maxExpiration: 99999 })]),
				listByOrgSlug: mock(async () => []),
				create: mock(async () => mockPolicy()),
				update: mock(async () => mockPolicy()),
				delete: mock(async () => {}),
			} as TrustPolicyRepositoryMock,
			makeAuth(mock(async () => "key")),
		);

		const req = validRequest();
		delete req.expiration;
		const res = await service.exchange(req);
		expect(res.expires_in).toBe(DEFAULT_EXCHANGE_EXPIRATION);
	});

	test("missing createCliAccessKey throws server_error 500", async () => {
		const service = new OidcExchangeService(
			{
				verify: mock(async () => ({ sub: "repo:acme/procella", repository: "acme/procella" })),
				dispose: mock(() => {}),
			},
			{
				findByOrgSlugAndIssuer: mock(async () => [mockPolicy()]),
				listByOrgSlug: mock(async () => []),
				create: mock(async () => mockPolicy()),
				update: mock(async () => mockPolicy()),
				delete: mock(async () => {}),
			} as TrustPolicyRepositoryMock,
			makeAuth(undefined),
		);

		try {
			await service.exchange(validRequest());
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(OidcExchangeError);
			const exchangeErr = error as OidcExchangeError;
			expect(exchangeErr.error).toBe("server_error");
			expect(exchangeErr.statusCode).toBe(500);
		}
	});

	test("workload claims are built from JWT claims", async () => {
		const createCliAccessKey = mock(
			async (
				_caller: unknown,
				_name: string,
				_opts?: { expireTime?: number; customClaims?: Record<string, unknown> },
			) => "key",
		);
		const service = new OidcExchangeService(
			{
				verify: mock(async () => ({
					sub: "repo:acme/procella",
					repository: "acme/procella",
					repository_id: "98765",
					repository_owner: "acme",
					repository_owner_id: "12345",
					workflow_ref: "acme/procella/.github/workflows/deploy.yml@refs/heads/main",
					environment: "prod",
					ref: "refs/heads/main",
					run_id: "111",
					actor: "octocat",
					actor_id: "42",
					jti: "jwt-id-1",
				})),
				dispose: mock(() => {}),
			},
			{
				findByOrgSlugAndIssuer: mock(async () => [mockPolicy()]),
				listByOrgSlug: mock(async () => []),
				create: mock(async () => mockPolicy()),
				update: mock(async () => mockPolicy()),
				delete: mock(async () => {}),
			} as TrustPolicyRepositoryMock,
			makeAuth(createCliAccessKey),
		);

		await service.exchange(validRequest());
		const call = createCliAccessKey.mock.calls[0];
		const opts = call?.[2] as { customClaims?: Record<string, unknown> } | undefined;
		expect(opts?.customClaims).toEqual({
			[OidcClaims.principalType]: "workload",
			[OidcClaims.workloadProvider]: "github-actions",
			[OidcClaims.workloadIssuer]: "https://token.actions.githubusercontent.com",
			[OidcClaims.workloadSub]: "repo:acme/procella",
			[OidcClaims.workloadRepo]: "acme/procella",
			[OidcClaims.workloadRepoId]: "98765",
			[OidcClaims.workloadRepoOwner]: "acme",
			[OidcClaims.workloadRepoOwnerId]: "12345",
			[OidcClaims.workloadWorkflowRef]:
				"acme/procella/.github/workflows/deploy.yml@refs/heads/main",
			[OidcClaims.workloadEnvironment]: "prod",
			[OidcClaims.workloadRef]: "refs/heads/main",
			[OidcClaims.workloadRunId]: "111",
			[OidcClaims.triggerActor]: "octocat",
			[OidcClaims.triggerActorId]: "42",
			[OidcClaims.workloadJti]: "jwt-id-1",
			[OidcClaims.orgSlug]: "acme",
		});
	});

	test("login format is github-actions:repo:env", async () => {
		const createCliAccessKey = mock(
			async (
				_caller: unknown,
				_name: string,
				_opts?: { expireTime?: number; customClaims?: Record<string, unknown> },
			) => "key",
		);
		const service = new OidcExchangeService(
			{
				verify: mock(async () => ({
					sub: "repo:acme/procella",
					repository: "acme/procella",
					environment: "prod",
				})),
				dispose: mock(() => {}),
			},
			{
				findByOrgSlugAndIssuer: mock(async () => [mockPolicy()]),
				listByOrgSlug: mock(async () => []),
				create: mock(async () => mockPolicy()),
				update: mock(async () => mockPolicy()),
				delete: mock(async () => {}),
			} as TrustPolicyRepositoryMock,
			makeAuth(createCliAccessKey),
		);

		await service.exchange(validRequest());
		const call = createCliAccessKey.mock.calls[0];
		const caller = call?.[0] as { login: string } | undefined;
		expect(caller?.login).toBe("github-actions:acme/procella:prod");
	});
});
