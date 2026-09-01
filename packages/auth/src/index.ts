// @procella/auth — Authentication via Descope JWT + dev mode token validation.
//
// Descope handles authn; tenant_id and roles from JWT drive authz.
// Dev mode uses a static token for local development.

import { timingSafeEqual } from "node:crypto";
import DescopeSdk from "@descope/node-sdk";
import { OidcClaims } from "@procella/oidc";
import { authAuthenticateDuration, authFailureCount, withSpan } from "@procella/telemetry";
import type { Caller, Role, WorkloadIdentity } from "@procella/types";
import { ForbiddenError, UnauthorizedError } from "@procella/types";
import { createRemoteJWKSet, jwtVerify } from "jose";

// ============================================================================
// Auth Service Interface
// ============================================================================

export interface AuthService {
	/** Authenticate a request, returning the Caller identity. */
	authenticate(request: Request): Promise<Caller>;
	/** Authenticate an update-token (lease token from StartUpdate). */
	authenticateUpdateToken(token: string): Promise<{ updateId: string; stackId: string }>;
	/** Resolve a stored user or access-key subject to a human-readable user identity. */
	resolveUserDisplayName(subject: string): Promise<string | null>;
	/** Create a long-lived CLI access key for the given caller. Returns the cleartext key. */
	createCliAccessKey?(
		caller: Caller,
		name: string,
		opts?: { expireTime?: number; customClaims?: Record<string, unknown> },
	): Promise<string>;
	/** Stop background timers (e.g. cache sweep). Called on server shutdown. */
	dispose?(): void;
}

// ============================================================================
// Auth Config
// ============================================================================

export type AuthConfig =
	| {
			mode: "dev";
			token: string;
			userLogin: string;
			orgLogin: string;
			users?: readonly DevAuthUser[];
	  }
	| {
			mode: "descope";
			projectId: string;
			managementKey?: string;
			issuer?: string;
			/** Custom Descope auth domain (e.g. https://auth.procella.cloud) — accepted as an additional JWT issuer. */
			authBaseUrl?: string;
	  };

// ============================================================================
// Dev Auth Service
// ============================================================================

export interface DevAuthUser {
	token: string;
	login: string;
	org: string;
	role: Role;
	/** Unix seconds; when set, authenticate rejects the key after this time. */
	expiresAt?: number;
}

export interface DevAuthConfig {
	token: string;
	userLogin: string;
	orgLogin: string;
	users?: readonly DevAuthUser[];
}

export class DevAuthService implements AuthService {
	/** Mutable so createCliAccessKey can register keys that authenticate() accepts. */
	private readonly users: DevAuthUser[];

	constructor(config: DevAuthConfig) {
		this.users = [
			{
				token: config.token,
				login: config.userLogin,
				org: config.orgLogin,
				role: "admin",
			},
			...(config.users ?? []),
		];
	}

	async authenticate(request: Request): Promise<Caller> {
		return withSpan("procella.auth", "auth.authenticate", { "auth.mode": "dev" }, async () => {
			const start = performance.now();
			try {
				const { token } = extractToken(request);
				const user = this.users.find((entry) => safeEqualString(token, entry.token));
				if (!user) {
					throw new UnauthorizedError("Invalid authentication token");
				}
				if (user.expiresAt !== undefined && Math.floor(Date.now() / 1000) >= user.expiresAt) {
					throw new UnauthorizedError("Invalid authentication token");
				}
				return {
					tenantId: user.org,
					orgSlug: user.org,
					userId: user.login,
					login: user.login,
					roles: [user.role],
					principalType: "user" as const,
				};
			} catch (error) {
				authFailureCount().add(1, { "auth.mode": "dev" });
				throw error;
			} finally {
				authAuthenticateDuration().record(performance.now() - start, { "auth.mode": "dev" });
			}
		});
	}

	async resolveUserDisplayName(subject: string): Promise<string | null> {
		return this.users.find((user) => user.login === subject)?.login ?? null;
	}

	async authenticateUpdateToken(token: string): Promise<{ updateId: string; stackId: string }> {
		return withSpan(
			"procella.auth",
			"auth.authenticateUpdateToken",
			{ "auth.mode": "dev" },
			async () => {
				const start = performance.now();
				try {
					return parseUpdateToken(token);
				} catch (error) {
					authFailureCount().add(1, { "auth.mode": "dev" });
					throw error;
				} finally {
					authAuthenticateDuration().record(performance.now() - start, { "auth.mode": "dev" });
				}
			},
		);
	}

	/**
	 * Local/dev stand-in for Descope access-key creation (enables /api/auth/cli-token e2e).
	 * Registers the cleartext in-process so authenticate() accepts it — single-process only,
	 * matching auth.mode=dev (Postgres-backed keys belong to DescopeAuthService / production).
	 */
	async createCliAccessKey(
		caller: Caller,
		name: string,
		opts?: { expireTime?: number; customClaims?: Record<string, unknown> },
	): Promise<string> {
		const token = `dev-cli:${caller.login}:${name}:${crypto.randomUUID()}`;
		const expireTime = opts?.expireTime ?? 0;
		this.users.push({
			token,
			login: caller.login,
			org: caller.orgSlug,
			role: caller.roles.includes("admin") ? "admin" : (caller.roles[0] ?? "viewer"),
			...(expireTime > 0 ? { expiresAt: expireTime } : {}),
		});
		return token;
	}
}

// ============================================================================
// Descope Auth Service
// ============================================================================

export interface DescopeAuthConfig {
	projectId: string;
	managementKey?: string;
	issuer?: string;
	/** Custom Descope auth domain — JWTs issued through it carry it as `iss`. */
	authBaseUrl?: string;
}

type DescopeClient = ReturnType<typeof DescopeSdk>;

const CLI_ACCESS_KEY_CUSTOM_CLAIM_ALLOWLIST = new Set<string>(Object.values(OidcClaims));

/** Cached access-key → Caller mapping with TTL from JWT exp claim. */
interface CachedAuth {
	caller: Caller;
	/** Unix timestamp (seconds) — re-exchange when now >= expiresAt. */
	expiresAt: number;
}

interface CachedUserDisplayName {
	value: string;
	expiresAt: number;
}

type DescopeUserIdentity = {
	email?: string;
	name?: string;
	givenName?: string;
	familyName?: string;
	loginIds?: string[];
};

export class DescopeAuthService implements AuthService {
	readonly sdk: DescopeClient;
	private readonly cache = new Map<string, CachedAuth>();
	private readonly pending = new Map<string, Promise<Caller>>();
	private readonly userDisplayNameCache = new Map<string, CachedUserDisplayName>();
	private readonly pendingUserDisplayNames = new Map<string, Promise<string | null>>();
	private readonly EXPIRY_MARGIN_S = 60;
	private readonly MAX_CACHE_TTL_S = 300;
	private readonly USER_DISPLAY_NAME_CACHE_TTL_MS = 5 * 60_000;
	private readonly projectId: string;
	private readonly issuer: string;
	/** Accepted `iss` values — the default api.descope.com issuer plus the custom auth domain (if any). */
	private readonly issuers: string[];
	private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
	private sweepTimer: ReturnType<typeof setInterval> | null = null;

	constructor(options: { sdk: DescopeClient; config: DescopeAuthConfig }) {
		this.sdk = options.sdk;
		this.projectId = options.config.projectId;
		this.issuer = options.config.issuer ?? buildDescopeIssuer(options.config.projectId);
		// Descope session cookies can carry `iss = <projectId>`; Bearer JWTs may use
		// the default URL issuer or, when issued through the custom auth domain,
		// `iss = https://<domain>/<projectId>`. Keys are the same project keys, so
		// the JWKS URL stays on the default issuer.
		const customIssuer = options.config.authBaseUrl
			? `${options.config.authBaseUrl.replace(/\/$/, "")}/${options.config.projectId}`
			: undefined;
		this.issuers = customIssuer
			? [this.issuer, this.projectId, customIssuer]
			: [this.issuer, this.projectId];
		this.jwks = createRemoteJWKSet(
			new URL(".well-known/jwks.json", this.issuer.endsWith("/") ? this.issuer : `${this.issuer}/`),
		);
		this.sweepTimer = setInterval(() => this.sweep(), 60_000);
		if (this.sweepTimer.unref) this.sweepTimer.unref();
	}

	async authenticate(request: Request): Promise<Caller> {
		return withSpan("procella.auth", "auth.authenticate", { "auth.mode": "descope" }, async () => {
			const start = performance.now();
			try {
				// Cookie-mode dashboards: Descope stores the session JWT in an HttpOnly
				// `DS` cookie on our apex domain, so the browser can't send a Bearer
				// header. Fall back to the cookie when no Authorization header exists.
				if (!request.headers.get("Authorization")) {
					return await this.authenticateSessionCookie(request);
				}

				const { scheme, token } = extractToken(request);

				// Block raw JWTs on the Pulumi CLI path — CLI should use access keys.
				// "token <value>" = CLI; "Bearer <value>" = UI dashboard (session JWTs OK there).
				if (scheme === "token" && token.startsWith("eyJ")) {
					throw new UnauthorizedError(
						"Session JWTs cannot be used as CLI tokens (they expire). Use `pulumi login` to create a long-lived access key.",
					);
				}

				// JWT tokens (Bearer from UI) — validate directly, no caching needed.
				if (token.startsWith("eyJ")) {
					return await this.verifySessionJwt(token);
				}

				// Access key tokens — cache the exchanged JWT.
				return this.authenticateAccessKey(token);
			} catch (error) {
				authFailureCount().add(1, { "auth.mode": "descope" });
				throw error;
			} finally {
				authAuthenticateDuration().record(performance.now() - start, { "auth.mode": "descope" });
			}
		});
	}

	/** Validate a Descope session JWT and map it to a Caller. */
	private async verifySessionJwt(token: string): Promise<Caller> {
		const { payload } = await jwtVerify(token, this.jwks, {
			algorithms: ["RS256"],
			issuer: this.issuers,
		});
		if (payload.aud && !audienceIncludes(payload.aud, this.projectId)) {
			throw new UnauthorizedError("JWT audience does not match project");
		}
		return this.extractCaller(payload as Record<string, unknown>);
	}

	/**
	 * Authenticate from Descope's session cookie (HttpOnly, set on the apex domain
	 * by the custom auth domain, sent implicitly on same-origin requests).
	 * Descope may name the session cookie `DS` or a dynamic `DFN-*` value, and
	 * multiple auth cookies can coexist when environments share a parent domain, so
	 * every JWT-shaped candidate is verified until one matches this project.
	 */
	private async authenticateSessionCookie(request: Request): Promise<Caller> {
		const tokens = extractSessionCookieTokens(request);
		if (tokens.length === 0) {
			throw new UnauthorizedError("Missing Authorization header");
		}
		for (const token of tokens) {
			try {
				return await this.verifySessionJwt(token);
			} catch {
				// Try the next candidate — may belong to a sibling environment.
			}
		}
		throw new UnauthorizedError("Invalid session cookie");
	}

	async authenticateUpdateToken(token: string): Promise<{ updateId: string; stackId: string }> {
		return withSpan(
			"procella.auth",
			"auth.authenticateUpdateToken",
			{ "auth.mode": "descope" },
			async () => {
				const start = performance.now();
				try {
					return parseUpdateToken(token);
				} catch (error) {
					authFailureCount().add(1, { "auth.mode": "descope" });
					throw error;
				} finally {
					authAuthenticateDuration().record(performance.now() - start, {
						"auth.mode": "descope",
					});
				}
			},
		);
	}

	async resolveUserDisplayName(subject: string): Promise<string | null> {
		if (!subject) return null;

		const cached = this.userDisplayNameCache.get(subject);
		if (cached && cached.expiresAt > Date.now()) return cached.value;

		const inflight = this.pendingUserDisplayNames.get(subject);
		if (inflight) return inflight;

		const lookup = this.loadUserDisplayName(subject);
		this.pendingUserDisplayNames.set(subject, lookup);
		try {
			const value = await lookup;
			if (value) {
				this.userDisplayNameCache.set(subject, {
					value,
					expiresAt: Date.now() + this.USER_DISPLAY_NAME_CACHE_TTL_MS,
				});
			}
			return value;
		} finally {
			this.pendingUserDisplayNames.delete(subject);
		}
	}

	private async loadUserDisplayName(subject: string): Promise<string | null> {
		const accessKey = await this.sdk.management.accessKey.load(subject).catch(() => undefined);
		const userId = accessKey?.ok ? accessKey.data?.boundUserId : undefined;
		if (accessKey?.ok && !userId) return null;

		const user = await this.sdk.management.user
			.loadByUserId(userId ?? subject)
			.then((response) => (response.ok ? response.data : undefined))
			.catch(() => undefined);
		return user ? formatUserDisplayName(user) : null;
	}

	async createCliAccessKey(
		caller: Caller,
		name: string,
		opts?: { expireTime?: number; customClaims?: Record<string, unknown> },
	): Promise<string> {
		const start = performance.now();
		return withSpan(
			"procella.auth",
			"auth.createCliAccessKey",
			{ "auth.mode": "descope" },
			async () => {
				try {
					// Skip user lookup for workload principals — they have no Descope user.
					const u =
						caller.principalType !== "workload" && caller.userId
							? await this.sdk.management.user
									.loadByUserId(caller.userId)
									.then((r) => (r.ok ? r.data : undefined))
									.catch(() => undefined)
							: undefined;
					const loginId =
						u?.email ??
						u?.name ??
						(u?.givenName && u?.familyName ? `${u.givenName} ${u.familyName}` : undefined) ??
						u?.loginIds?.[0] ??
						caller.login; // use pre-computed login for workload callers
					const expireTime = opts?.expireTime ?? 0;
					const safeCustomClaims = sanitizeCliAccessKeyCustomClaims(opts?.customClaims);
					const customClaims = {
						procellaLogin: loginId,
						procellaOrgSlug: caller.orgSlug,
						...safeCustomClaims,
					};

					const resp = await this.sdk.management.accessKey.create(
						name,
						expireTime,
						undefined,
						[{ tenantId: caller.tenantId, roleNames: [...caller.roles] }],
						caller.userId || undefined, // pass undefined for workload (empty string) to avoid Descope 33-char limit
						customClaims,
					);
					if (!resp.ok || !resp.data?.cleartext) {
						throw new Error(
							resp.error?.errorMessage ??
								resp.error?.errorDescription ??
								"Failed to create access key",
						);
					}
					return resp.data.cleartext;
				} catch (error) {
					authFailureCount().add(1, { "auth.mode": "descope" });
					throw error;
				} finally {
					authAuthenticateDuration().record(performance.now() - start, {
						"auth.mode": "descope",
					});
				}
			},
		);
	}

	/** Stop the sweep timer. Call on server shutdown. */
	dispose(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
		this.userDisplayNameCache.clear();
		this.pendingUserDisplayNames.clear();
	}

	// ---- Private: Cache ------------------------------------------------

	private async authenticateAccessKey(accessKey: string): Promise<Caller> {
		// 1. Check cache
		const cached = this.cache.get(accessKey);
		if (cached && cached.expiresAt > Math.floor(Date.now() / 1000)) {
			return cached.caller;
		}

		// 2. Deduplicate concurrent exchanges for the same key
		const inflight = this.pending.get(accessKey);
		if (inflight) {
			return inflight;
		}

		// 3. Exchange and cache
		const promise = this.doExchange(accessKey);
		this.pending.set(accessKey, promise);

		try {
			return await promise;
		} finally {
			this.pending.delete(accessKey);
		}
	}

	private async doExchange(accessKey: string): Promise<Caller> {
		const maxAttempts = 3;
		let lastErr: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const started = performance.now();
			try {
				const authInfo = await this.sdk.exchangeAccessKey(accessKey);
				const claims = authInfo.token;
				const exp = typeof claims.exp === "number" ? claims.exp : undefined;

				const caller = this.extractCaller(claims);

				if (exp) {
					const nowSec = Math.floor(Date.now() / 1000);
					const desiredExpiry = exp - this.EXPIRY_MARGIN_S;
					const cappedExpiry = Math.min(desiredExpiry, nowSec + this.MAX_CACHE_TTL_S);
					if (cappedExpiry > nowSec) {
						this.cache.set(accessKey, { caller, expiresAt: cappedExpiry });
					}
				}

				return caller;
			} catch (err) {
				const elapsed = (performance.now() - started).toFixed(0);
				lastErr = err;
				if (attempt < maxAttempts) {
					const delay = attempt * 500;
					// biome-ignore lint/suspicious/noConsole: auth retry diagnostics
					console.warn(
						`[auth] exchangeAccessKey attempt ${attempt}/${maxAttempts} failed after ${elapsed}ms, retrying in ${delay}ms: ${err}`,
					);
					await new Promise((r) => setTimeout(r, delay));
				} else {
					console.error(
						`[auth] exchangeAccessKey FAILED after ${attempt} attempt(s) ${elapsed}ms: ${err}`,
					);
				}
			}
		}
		throw lastErr;
	}

	private extractCaller(claims: Record<string, unknown>): Caller {
		const tenantId = extractTenantId(claims);
		if (!tenantId) {
			throw new UnauthorizedError("JWT missing tenant claim");
		}

		const userId = typeof claims.sub === "string" ? claims.sub : "";
		const login =
			typeof claims.procellaLogin === "string" && claims.procellaLogin
				? claims.procellaLogin
				: typeof claims.strataLogin === "string" && claims.strataLogin
					? claims.strataLogin
					: userId;
		const roles = extractRoles(claims, tenantId);
		const principalTypeRaw = claims[OidcClaims.principalType];
		const isWorkload = principalTypeRaw === "workload";

		const workload: WorkloadIdentity | undefined = isWorkload
			? {
					provider: String(claims[OidcClaims.workloadProvider] ?? ""),
					issuer: optionalString(claims[OidcClaims.workloadIssuer]) ?? "",
					subject: String(claims[OidcClaims.workloadSub] ?? ""),
					repository: optionalString(claims[OidcClaims.workloadRepo]),
					repositoryId: optionalString(claims[OidcClaims.workloadRepoId]),
					repositoryOwner: optionalString(claims[OidcClaims.workloadRepoOwner]),
					repositoryOwnerId: optionalString(claims[OidcClaims.workloadRepoOwnerId]),
					workflowRef: optionalString(claims[OidcClaims.workloadWorkflowRef]),
					environment: optionalString(claims[OidcClaims.workloadEnvironment]),
					ref: optionalString(claims[OidcClaims.workloadRef]),
					runId: optionalString(claims[OidcClaims.workloadRunId]),
					actor: optionalString(claims[OidcClaims.triggerActor]),
					actorId: optionalString(claims[OidcClaims.triggerActorId]),
					jti: optionalString(claims[OidcClaims.workloadJti]),
				}
			: undefined;

		return {
			tenantId,
			orgSlug: extractOrgSlug(claims, tenantId),
			userId,
			login,
			roles,
			principalType: isWorkload ? "workload" : userId.startsWith("token:") ? "token" : "user",
			workload,
		};
	}

	private sweep(): void {
		const now = Math.floor(Date.now() / 1000);
		const nowMs = Date.now();
		for (const [key, entry] of this.cache) {
			if (entry.expiresAt <= now) {
				this.cache.delete(key);
			}
		}
		for (const [key, entry] of this.userDisplayNameCache) {
			if (entry.expiresAt <= nowMs) {
				this.userDisplayNameCache.delete(key);
			}
		}
	}
}

function formatUserDisplayName(user: DescopeUserIdentity): string | null {
	const fullName = [user.givenName, user.familyName].filter(Boolean).join(" ");
	for (const candidate of [user.email, user.name, fullName, user.loginIds?.[0]]) {
		if (candidate?.trim()) return candidate.trim();
	}
	return null;
}

function optionalString(v: unknown): string | undefined {
	return typeof v === "string" && v ? v : undefined;
}

// ============================================================================
// Factory
// ============================================================================

export function createAuthService(config: AuthConfig): AuthService {
	switch (config.mode) {
		case "dev":
			return new DevAuthService({
				token: config.token,
				userLogin: config.userLogin,
				orgLogin: config.orgLogin,
				users: config.users,
			});
		case "descope": {
			const sdk = DescopeSdk({
				projectId: config.projectId,
				managementKey: config.managementKey,
			});
			return new DescopeAuthService({
				sdk,
				config: {
					projectId: config.projectId,
					managementKey: config.managementKey,
					issuer: config.issuer,
					authBaseUrl: config.authBaseUrl,
				},
			});
		}
	}
}

// ============================================================================
// Authorization Helpers
// ============================================================================

/** HTTP method → minimum role mapping for RBAC. */
export const METHOD_ROLE_MAP: Record<string, Role> = {
	GET: "viewer",
	HEAD: "viewer",
	POST: "member",
	PUT: "member",
	PATCH: "member",
	DELETE: "admin",
};

/** Check if caller has at least one of the required roles. Throws ForbiddenError if not. */
export function requireRole(caller: Caller, ...roles: Role[]): void {
	// Admin always passes
	if (caller.roles.includes("admin")) {
		return;
	}
	// Member passes for member or viewer checks
	if (caller.roles.includes("member") && roles.some((r) => r === "member" || r === "viewer")) {
		return;
	}
	// Viewer passes only for viewer checks
	if (caller.roles.includes("viewer") && roles.includes("viewer")) {
		return;
	}
	throw new ForbiddenError(`Caller ${caller.login} lacks required role: ${roles.join(", ")}`);
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Extract bearer/token from Authorization header (supports Pulumi CLI + standard formats). */
function extractToken(request: Request): { scheme: "token" | "bearer"; token: string } {
	const header = request.headers.get("Authorization");
	if (!header) {
		throw new UnauthorizedError("Missing Authorization header");
	}

	// Pulumi CLI format: "token <value>"
	if (header.startsWith("token ")) {
		const value = header.slice(6).trim();
		if (!value) throw new UnauthorizedError("Empty token value");
		return { scheme: "token", token: value };
	}

	// Standard Bearer format: "Bearer <value>"
	if (header.startsWith("Bearer ")) {
		const value = header.slice(7).trim();
		if (!value) throw new UnauthorizedError("Empty Bearer token");
		return { scheme: "bearer", token: value };
	}

	throw new UnauthorizedError("Invalid Authorization header format");
}

/**
 * Extract all JWT-shaped cookie values from a request's Cookie header.
 *
 * Descope's docs call out the default `DS` name, but custom-domain cookie mode
 * can also emit dynamic names like `DFN-...`. Cookie names are not security
 * boundaries here — issuer/audience/signature verification is. Header auth still
 * takes precedence; this is only the no-Authorization cookie fallback.
 */
export function extractSessionCookieTokens(request: Request): string[] {
	const header = request.headers.get("Cookie");
	if (!header) return [];
	const tokens: string[] = [];
	for (const pair of header.split(";")) {
		const eq = pair.indexOf("=");
		if (eq === -1) continue;
		const value = decodeCookieValue(pair.slice(eq + 1).trim());
		if (value.startsWith("eyJ")) tokens.push(value);
	}
	return tokens;
}

function decodeCookieValue(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function audienceIncludes(audience: string | string[], projectId: string): boolean {
	return Array.isArray(audience) ? audience.includes(projectId) : audience === projectId;
}

/** Parse update token format: "update:<updateId>:<stackId>:<secret>" */
function parseUpdateToken(token: string): { updateId: string; stackId: string } {
	const parts = token.split(":");
	if (parts.length !== 4 || parts[0] !== "update" || !parts[1] || !parts[2] || !parts[3]) {
		throw new UnauthorizedError("Invalid update token format");
	}
	return { updateId: parts[1], stackId: parts[2] };
}

function buildDescopeIssuer(projectId: string): string {
	return `https://api.descope.com/${projectId}`;
}

function safeEqualString(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Extract tenant ID from Descope JWT claims. */
function extractTenantId(claims: Record<string, unknown>): string | undefined {
	// `dct` = Descope Current Tenant (set when authenticating with tenant context)
	if (typeof claims.dct === "string" && claims.dct) {
		return claims.dct;
	}

	// Fallback: look in tenants object — MUST have exactly one tenant.
	// Multiple tenants would make resolution non-deterministic (Object.keys ordering varies).
	if (claims.tenants && typeof claims.tenants === "object") {
		const tenantIds = Object.keys(claims.tenants as Record<string, unknown>);
		if (tenantIds.length === 1) {
			return tenantIds[0];
		}
	}

	return undefined;
}

/**
 * Derive a URL-safe org slug from JWT claims.
 *
 * Resolution order:
 *   1. Explicit `procellaOrgSlug` claim (set by OIDC exchange — authoritative)
 *   2. Top-level `tenant_name` (present in session JWTs via Descope JWT Templates)
 *   3. Nested `tenants.<tenantId>.name` (present in CLI access key JWTs)
 *   4. Raw tenantId as last resort
 */
export function extractOrgSlug(claims: Record<string, unknown>, tenantId: string): string {
	// 1. Explicit orgSlug from OIDC workload claims (authoritative, set by trust policy)
	const explicit = claims[OidcClaims.orgSlug];
	if (typeof explicit === "string" && explicit) return explicit;

	// 2. Top-level tenant_name (present in session JWTs)
	const topLevel =
		typeof claims.tenant_name === "string" && claims.tenant_name ? claims.tenant_name : undefined;
	if (topLevel) return slugify(topLevel) || tenantId;

	// 3. Nested tenants.<id>.name (present in CLI access key JWTs)
	if (claims.tenants && typeof claims.tenants === "object") {
		const tenants = claims.tenants as Record<string, Record<string, unknown>>;
		const name = tenants[tenantId]?.name;
		if (typeof name === "string" && name) return slugify(name) || tenantId;
	}

	// 4. Last resort — should not happen if Descope is configured correctly
	return tenantId;
}

/** Convert a string to a URL-safe slug (lowercase, alphanumeric + hyphens). */
export function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-/, "")
		.replace(/-$/, "");
}

/** Extract roles from Descope JWT claims for a specific tenant. */
export function extractRoles(claims: Record<string, unknown>, tenantId: string): Role[] {
	const validRoles = new Set<string>(["admin", "member", "viewer"]);
	const roles: Role[] = [];

	// Descope puts per-tenant roles in: tenants.<tenantId>.roles
	if (claims.tenants && typeof claims.tenants === "object") {
		const tenants = claims.tenants as Record<string, Record<string, unknown>>;
		const tenantClaims = tenants[tenantId];
		if (tenantClaims?.roles && Array.isArray(tenantClaims.roles)) {
			for (const role of tenantClaims.roles) {
				if (typeof role === "string" && validRoles.has(role)) {
					roles.push(role as Role);
				}
			}
		}
	}

	return roles;
}

function sanitizeCliAccessKeyCustomClaims(
	customClaims: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (!customClaims) {
		return {};
	}

	const safeClaims: Record<string, unknown> = {};
	const strippedClaims: string[] = [];

	for (const [claim, value] of Object.entries(customClaims)) {
		if (claim === "procellaLogin" || claim === "procellaOrgSlug") {
			strippedClaims.push(claim);
			continue;
		}

		if (CLI_ACCESS_KEY_CUSTOM_CLAIM_ALLOWLIST.has(claim)) {
			safeClaims[claim] = value;
			continue;
		}

		strippedClaims.push(claim);
	}

	if (strippedClaims.length > 0) {
		// biome-ignore lint/suspicious/noConsole: security warning when caller customClaims include reserved fields
		console.warn(
			`[auth] stripping unsupported CLI access-key custom claims: ${strippedClaims.join(", ")}`,
		);
	}

	return safeClaims;
}
