// Session-claims helper for tenant extraction when the JWT lives in an
// HttpOnly cookie and is unavailable to browser code.

export type SessionClaims = Record<string, unknown>;

/** Tenant ID from Descope session claims — `dct` (current tenant), falling back to a single `tenants` key. */
export function tenantFromClaims(claims: SessionClaims | null | undefined): string {
	if (!claims) return "";
	if (typeof claims.dct === "string" && claims.dct) return claims.dct;
	if (claims.tenants && typeof claims.tenants === "object") {
		const ids = Object.keys(claims.tenants as Record<string, unknown>);
		if (ids.length === 1) return ids[0];
	}
	return "";
}
