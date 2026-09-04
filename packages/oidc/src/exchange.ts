import type { Caller } from "@procella/types";
import {
	AUDIENCE_PREFIX,
	DEFAULT_EXCHANGE_EXPIRATION,
	GRANT_TYPE_TOKEN_EXCHANGE,
	OidcClaims,
	REQUESTED_TOKEN_TYPE_ORG,
	SUBJECT_TOKEN_TYPE_ID_TOKEN,
} from "./claims.js";
import { JwksValidationError } from "./jwks.js";
import { findMatchingPolicy } from "./policy.js";
import type {
	JwksValidator,
	OidcService,
	OidcTrustPolicy,
	TokenExchangeRequest,
	TokenExchangeResponse,
	TrustPolicyRepository,
} from "./types.js";

interface TokenMinter {
	createCliAccessKey?(
		caller: Caller,
		name: string,
		opts?: { expireTime?: number; customClaims?: Record<string, unknown> },
	): Promise<string>;
}

export class OidcExchangeService implements OidcService {
	constructor(
		private jwks: JwksValidator,
		private policies: TrustPolicyRepository,
		private auth: TokenMinter,
	) {}

	async exchange(req: TokenExchangeRequest): Promise<TokenExchangeResponse> {
		if (req.grantType !== GRANT_TYPE_TOKEN_EXCHANGE) {
			throw new OidcExchangeError("unsupported_grant_type", "Unsupported grant_type");
		}
		if (req.subjectTokenType !== SUBJECT_TOKEN_TYPE_ID_TOKEN) {
			throw new OidcExchangeError("invalid_request", "Unsupported subject_token_type");
		}
		if (req.requestedTokenType && req.requestedTokenType !== REQUESTED_TOKEN_TYPE_ORG) {
			throw new OidcExchangeError(
				"invalid_request",
				`Unsupported requested_token_type: ${req.requestedTokenType}. Only organization tokens are supported.`,
			);
		}

		if (!req.audience.startsWith(AUDIENCE_PREFIX)) {
			throw new OidcExchangeError("invalid_target", `audience must start with ${AUDIENCE_PREFIX}`);
		}
		const orgSlug = req.audience.slice(AUDIENCE_PREFIX.length);
		if (!orgSlug) {
			throw new OidcExchangeError("invalid_target", "audience missing org name");
		}
		// Extract the issuer from the JWT header WITHOUT full verification.
		// This is safe because we only use it for policy lookup, not for trust.
		// The actual JWT verification happens below with the policy's expected issuer.
		const tokenIssuer = this.extractIssuerFromToken(req.subjectToken);
		if (!tokenIssuer) {
			throw new OidcExchangeError("invalid_request", "subject_token missing issuer claim");
		}

		// Resolve candidate policies by (orgSlug, issuer) — scoped lookup.
		const policies = await this.policies.findByOrgSlugAndIssuer(orgSlug, tokenIssuer);
		if (policies.length === 0) {
			throw new OidcExchangeError("access_denied", "Token exchange not available", 403);
		}

		// Tenant isolation: all candidate policies MUST belong to exactly one tenant.
		const tenantIds = new Set(policies.map((p) => p.tenantId));
		if (tenantIds.size !== 1) {
			throw new OidcExchangeError("access_denied", "Token exchange not available", 403);
		}

		// Now verify the JWT and evaluate claim conditions.
		let claims: Record<string, unknown> | null = null;
		let matchedPolicy: OidcTrustPolicy | null = null;

		for (const policy of policies) {
			if (!policy.active) continue;
			try {
				const verified = await this.jwks.verify(req.subjectToken, policy.issuer, req.audience);
				if (findMatchingPolicy([policy], verified)) {
					claims = verified;
					matchedPolicy = policy;
					break;
				}
			} catch (err) {
				if (err instanceof JwksValidationError) {
					continue;
				}
				throw err;
			}
		}

		if (!matchedPolicy || !claims) {
			throw new OidcExchangeError("access_denied", "Token exchange not available", 403);
		}

		const requestedExpiration = req.expiration ?? DEFAULT_EXCHANGE_EXPIRATION;
		const clampedExpiration =
			Number.isFinite(requestedExpiration) && requestedExpiration > 0
				? Math.floor(requestedExpiration)
				: DEFAULT_EXCHANGE_EXPIRATION;
		const expiration = Math.min(clampedExpiration, matchedPolicy.maxExpiration);
		const workloadClaims = buildWorkloadClaims(claims, matchedPolicy);
		const expireTime = Math.floor(Date.now() / 1000) + expiration;

		const syntheticCaller: Caller = {
			tenantId: matchedPolicy.tenantId,
			orgSlug: matchedPolicy.orgSlug,
			// Descope userId field must be ≤33 chars and is optional for workload keys.
			// Use an empty string to avoid binding to a non-existent user.
			userId: "",
			login: buildWorkloadLogin(claims, matchedPolicy),
			roles: [matchedPolicy.grantedRole],
			principalType: "workload",
		};

		if (!this.auth.createCliAccessKey) {
			throw new OidcExchangeError("server_error", "Token minting not available", 500);
		}

		const accessToken = await this.auth.createCliAccessKey(syntheticCaller, `oidc-${orgSlug}`, {
			expireTime,
			customClaims: { ...workloadClaims, [OidcClaims.orgSlug]: matchedPolicy.orgSlug },
		});

		return {
			access_token: accessToken,
			issued_token_type: REQUESTED_TOKEN_TYPE_ORG,
			token_type: "Bearer",
			expires_in: expiration,
			scope: "",
		};
	}

	/**
	 * Extract the `iss` claim from a JWT WITHOUT verification.
	 * Used only for policy routing — the JWT is fully verified later.
	 */
	private extractIssuerFromToken(jwt: string): string | undefined {
		try {
			const parts = jwt.split(".");
			if (parts.length !== 3) return undefined;
			const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
			return typeof payload.iss === "string" ? payload.iss : undefined;
		} catch {
			return undefined;
		}
	}
}

function buildWorkloadClaims(
	jwtClaims: Record<string, unknown>,
	policy: OidcTrustPolicy,
): Record<string, unknown> {
	return {
		[OidcClaims.principalType]: "workload",
		[OidcClaims.workloadProvider]: policy.provider,
		[OidcClaims.workloadIssuer]: policy.issuer,
		[OidcClaims.workloadSub]: String(jwtClaims.sub ?? ""),
		[OidcClaims.workloadRepo]: optStr(jwtClaims.repository),
		[OidcClaims.workloadRepoId]: optStr(jwtClaims.repository_id),
		[OidcClaims.workloadRepoOwner]: optStr(jwtClaims.repository_owner),
		[OidcClaims.workloadRepoOwnerId]: optStr(jwtClaims.repository_owner_id),
		[OidcClaims.workloadWorkflowRef]: optStr(jwtClaims.workflow_ref),
		[OidcClaims.workloadEnvironment]: optStr(jwtClaims.environment),
		[OidcClaims.workloadRef]: optStr(jwtClaims.ref),
		[OidcClaims.workloadRunId]: optStr(jwtClaims.run_id),
		[OidcClaims.triggerActor]: optStr(jwtClaims.actor),
		[OidcClaims.triggerActorId]: optStr(jwtClaims.actor_id),
		[OidcClaims.workloadJti]: optStr(jwtClaims.jti),
	};
}

function buildWorkloadLogin(jwtClaims: Record<string, unknown>, policy: OidcTrustPolicy): string {
	const repo = String(jwtClaims.repository ?? "unknown");
	const env = jwtClaims.environment ? `:${String(jwtClaims.environment)}` : "";
	return `${policy.provider}:${repo}${env}`;
}

function optStr(v: unknown): string | undefined {
	if (typeof v === "string" && v) return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return undefined;
}

export class OidcExchangeError extends Error {
	constructor(
		public readonly error: string,
		public readonly errorDescription: string,
		public readonly statusCode: number = 400,
	) {
		super(errorDescription);
		this.name = "OidcExchangeError";
	}
}
