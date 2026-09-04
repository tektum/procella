import { type Database, oidcTrustPolicies } from "@procella/db";
import { ProcellaError } from "@procella/types";
import { and, eq, sql } from "drizzle-orm";
import type { OidcTrustPolicy, TrustPolicyRepository } from "./types.js";

const GITHUB_ACTIONS_PROVIDER = "github-actions";

type PolicyClaimValidationInput = Pick<OidcTrustPolicy, "provider" | "issuer" | "claimConditions">;

export class OidcPolicyConflictError extends ProcellaError {
	constructor() {
		super("OIDC trust policy with this org/issuer pair already exists", "policy_conflict", 409);
		this.name = "OidcPolicyConflictError";
	}
}

export class OidcPolicyDisplayNameConflictError extends ProcellaError {
	constructor() {
		super(
			"OIDC trust policy with this display name already exists in the tenant",
			"policy_display_name_conflict",
			409,
		);
		this.name = "OidcPolicyDisplayNameConflictError";
	}
}

export class OidcPolicyClaimConditionsError extends ProcellaError {
	constructor(message: string) {
		super(message, "policy_claim_conditions_invalid", 400);
		this.name = "OidcPolicyClaimConditionsError";
	}
}

export class PostgresTrustPolicyRepository implements TrustPolicyRepository {
	constructor(private readonly db: Database) {}

	async findByOrgSlugAndIssuer(orgSlug: string, issuer: string): Promise<OidcTrustPolicy[]> {
		const rows = await this.db
			.select()
			.from(oidcTrustPolicies)
			.where(and(eq(oidcTrustPolicies.orgSlug, orgSlug), eq(oidcTrustPolicies.issuer, issuer)));
		return rows.map(mapRow);
	}

	async listByOrgSlug(orgSlug: string, tenantId: string): Promise<OidcTrustPolicy[]> {
		const rows = await this.db
			.select()
			.from(oidcTrustPolicies)
			.where(and(eq(oidcTrustPolicies.orgSlug, orgSlug), eq(oidcTrustPolicies.tenantId, tenantId)));
		return rows.map(mapRow);
	}

	async create(
		policy: Omit<OidcTrustPolicy, "id" | "createdAt" | "updatedAt">,
	): Promise<OidcTrustPolicy> {
		validateTrustPolicyClaimConditions(policy);

		try {
			const row = await this.db.transaction(async (tx) => {
				// Phase A keeps the tenant-scoped index for rolling-deploy compatibility.
				// Every upgraded replica serializes ownership checks on the global pair.
				const ownershipKey = JSON.stringify([policy.orgSlug, policy.issuer]);
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownershipKey}, 0))`);

				const [existing] = await tx
					.select({ id: oidcTrustPolicies.id })
					.from(oidcTrustPolicies)
					.where(
						and(
							eq(oidcTrustPolicies.orgSlug, policy.orgSlug),
							eq(oidcTrustPolicies.issuer, policy.issuer),
						),
					);
				if (existing) throw new OidcPolicyConflictError();

				const [inserted] = await tx
					.insert(oidcTrustPolicies)
					.values({
						tenantId: policy.tenantId,
						orgSlug: policy.orgSlug,
						provider: policy.provider,
						displayName: policy.displayName,
						issuer: policy.issuer,
						maxExpiration: policy.maxExpiration,
						claimConditions: policy.claimConditions,
						grantedRole: policy.grantedRole,
						active: policy.active,
					})
					.returning();

				if (!inserted) throw new Error("Failed to create trust policy");
				return inserted;
			});
			return mapRow(row);
		} catch (error) {
			if (pgErrorCode(error) === "23505") {
				if (pgConstraintName(error) === "idx_oidc_trust_org_name") {
					throw new OidcPolicyDisplayNameConflictError();
				}
				throw new OidcPolicyConflictError();
			}
			throw error;
		}
	}

	async update(
		id: string,
		tenantId: string,
		patch: Partial<
			Pick<
				OidcTrustPolicy,
				"displayName" | "claimConditions" | "grantedRole" | "maxExpiration" | "active"
			>
		>,
	): Promise<OidcTrustPolicy> {
		if (patch.claimConditions) {
			const [existing] = await this.db
				.select({ provider: oidcTrustPolicies.provider, issuer: oidcTrustPolicies.issuer })
				.from(oidcTrustPolicies)
				.where(and(eq(oidcTrustPolicies.id, id), eq(oidcTrustPolicies.tenantId, tenantId)));

			if (!existing) throw new Error(`Trust policy ${id} not found`);

			validateTrustPolicyClaimConditions({
				provider: existing.provider,
				issuer: existing.issuer,
				claimConditions: patch.claimConditions,
			});
		}

		const [row] = await this.db
			.update(oidcTrustPolicies)
			.set({ ...patch, updatedAt: new Date() })
			.where(and(eq(oidcTrustPolicies.id, id), eq(oidcTrustPolicies.tenantId, tenantId)))
			.returning();

		if (!row) throw new Error(`Trust policy ${id} not found`);
		return mapRow(row);
	}

	async delete(id: string, tenantId: string): Promise<void> {
		await this.db
			.delete(oidcTrustPolicies)
			.where(and(eq(oidcTrustPolicies.id, id), eq(oidcTrustPolicies.tenantId, tenantId)));
	}
}

export function validateTrustPolicyClaimConditions(policy: PolicyClaimValidationInput): void {
	const error = getTrustPolicyClaimConditionsError(policy);
	if (error) {
		throw new OidcPolicyClaimConditionsError(error);
	}
}

function getTrustPolicyClaimConditionsError(policy: PolicyClaimValidationInput): string | null {
	const claimKeys = Object.keys(policy.claimConditions);
	if (claimKeys.length < 2) {
		return "OIDC trust policy must require at least two claim conditions";
	}

	if (!hasNarrowingClaim(policy)) {
		if (policy.provider === GITHUB_ACTIONS_PROVIDER) {
			return "OIDC trust policy must include a GitHub repository identity claim (repository_owner_id, repository_id, repository_owner, repository, or non-wildcard sub)";
		}
		return "OIDC trust policy must include a narrowing claim (non-wildcard sub, non-default aud, email, email_verified=true, or tid)";
	}

	return null;
}

function hasNarrowingClaim(policy: PolicyClaimValidationInput): boolean {
	const { claimConditions, issuer, provider } = policy;
	if (hasNonEmptyClaim(claimConditions.repository_owner_id)) return true;
	if (hasNonEmptyClaim(claimConditions.repository_id)) return true;
	if (hasNonEmptyClaim(claimConditions.repository_owner)) return true;
	if (hasNonEmptyClaim(claimConditions.repository)) return true;
	if (hasNonEmptyClaim(claimConditions.sub) && claimConditions.sub !== "*") return true;

	if (provider !== GITHUB_ACTIONS_PROVIDER) {
		if (hasNonEmptyClaim(claimConditions.aud) && claimConditions.aud !== issuer) return true;
		if (hasNonEmptyClaim(claimConditions.email)) return true;
		if (claimConditions.email_verified === "true") return true;
		if (hasNonEmptyClaim(claimConditions.tid)) return true;
	}

	return false;
}

function hasNonEmptyClaim(value: string | undefined): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function pgErrorCode(err: unknown): string | undefined {
	let current: unknown = err;
	for (let i = 0; i < 10 && current != null; i++) {
		if (typeof current === "object") {
			const record = current as Record<string, unknown>;
			for (const key of ["code", "errno"] as const) {
				const raw = record[key];
				const normalized = typeof raw === "number" ? String(raw) : raw;
				if (typeof normalized === "string" && /^[0-9A-Z]{5}$/i.test(normalized)) {
					return normalized;
				}
			}
			if (Array.isArray(record.errors)) {
				for (const inner of record.errors) {
					const code = pgErrorCode(inner);
					if (code) return code;
				}
			}
			if ("cause" in record) {
				current = record.cause;
				continue;
			}
		}
		current = undefined;
	}
	return undefined;
}

function pgConstraintName(err: unknown): string | undefined {
	let current: unknown = err;
	for (let i = 0; i < 10 && current != null; i++) {
		if (typeof current === "object") {
			const record = current as Record<string, unknown>;
			for (const key of ["constraint", "constraint_name"] as const) {
				const value = record[key];
				if (typeof value === "string" && value.length > 0) return value;
			}
			if (Array.isArray(record.errors)) {
				for (const inner of record.errors) {
					const name = pgConstraintName(inner);
					if (name) return name;
				}
			}
			if ("cause" in record) {
				current = record.cause;
				continue;
			}
		}
		current = undefined;
	}
	return undefined;
}

function mapRow(row: typeof oidcTrustPolicies.$inferSelect): OidcTrustPolicy {
	return {
		id: row.id,
		tenantId: row.tenantId,
		orgSlug: row.orgSlug,
		provider: row.provider,
		displayName: row.displayName,
		issuer: row.issuer,
		maxExpiration: row.maxExpiration,
		claimConditions: row.claimConditions,
		grantedRole: row.grantedRole as OidcTrustPolicy["grantedRole"],
		active: row.active,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export function matchPolicy(policy: OidcTrustPolicy, jwtClaims: Record<string, unknown>): boolean {
	if (getTrustPolicyClaimConditionsError(policy) !== null) return false;
	for (const [key, expectedValue] of Object.entries(policy.claimConditions)) {
		const actualValue = jwtClaims[key];
		// Strict: claim must exist and be a string or number. Reject undefined/null/object.
		if (actualValue === undefined || actualValue === null) return false;
		if (typeof actualValue !== "string" && typeof actualValue !== "number") return false;
		if (String(actualValue) !== expectedValue) return false;
	}
	return true;
}

export function findMatchingPolicy(
	policies: OidcTrustPolicy[],
	jwtClaims: Record<string, unknown>,
): OidcTrustPolicy | null {
	return policies.find((policy) => matchPolicy(policy, jwtClaims)) ?? null;
}
