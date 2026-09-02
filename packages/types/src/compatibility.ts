// @procella/types — Pulumi CLI/service-backend compatibility policy.
//
// This is the single hand-maintained source of truth for:
//   1. The support-tier versions (legacy smoke floor, fully supported minimum).
//      The contract version (the exact CLI the full E2E suite is pinned to)
//      is intentionally NOT duplicated here — it is derived from the Pulumi
//      SDK version pinned in packages/types/tygo/go.mod.
//   2. An exhaustive classification of every upstream Pulumi APICapability
//      (as generated into pulumi.gen.ts) and every upstream PulumiRoutes key
//      (as generated into routes.gen.ts).
//   3. Procella-local protocol extensions that are NOT part of the upstream
//      Pulumi apitype capability set (currently only journaling-v1).
//
// `validateCompatibilityManifest` is pure and fail-closed: given the set of
// capability/route identifiers the generated upstream files currently
// declare, it reports every missing, extra, duplicate, or malformed
// classification. It is used both by the standalone checker script
// (packages/types/tygo/check-compatibility-manifest.ts) and by unit tests.

// ============================================================================
// Support-tier versions
// ============================================================================

/**
 * Oldest Pulumi CLI version covered by compatibility smoke tests: login,
 * identity, stack CRUD and lifecycle, direct cancellation, secret config,
 * state import/export, and legacy requests without an Accept header.
 */
export const PULUMI_LEGACY_SMOKE_VERSION = "3.9.0";

/**
 * Fully supported minimum Pulumi CLI version: API v9 client behavior,
 * including tolerant SecretValue decoding. This is the documented support
 * floor for new installations and support cases. It is a testing/support
 * policy, not a runtime rejection policy — legacy routes keep accepting
 * clients below this floor.
 */
export const PULUMI_FULLY_SUPPORTED_MIN_VERSION = "3.233.0";

// ============================================================================
// Classification statuses
// ============================================================================

/** Closed set of classification statuses for upstream capabilities/routes. */
export const CompatibilityStatus = {
	/** Procella implements this and advertises/serves it by default. */
	CoreImplemented: "core-implemented",
	/**
	 * Procella implements this, but it is gated behind an operator opt-in and
	 * is not advertised/enabled by default (e.g. delta-checkpoint-uploads-v2,
	 * pending Phase 4 rollout evidence).
	 */
	ImplementedOptIn: "implemented-opt-in",
	/**
	 * Pulumi Cloud-only or enterprise-only surface (deployments, insights,
	 * policy administration, usage, registry publishing, Copilot, etc.) that
	 * Procella does not implement.
	 */
	IntentionallyUnsupported: "intentionally-unsupported",
	/**
	 * Declared upstream but not yet invoked by a released CLI against this
	 * capability/route, or behaviorally unverified. Not advertised.
	 */
	Watching: "watching",
} as const;
export type CompatibilityStatus = (typeof CompatibilityStatus)[keyof typeof CompatibilityStatus];

/**
 * Reserved status for Procella-local protocol extensions that are NOT part
 * of the upstream Pulumi apitype capability set. Distinct from
 * `CompatibilityStatus` so a local extension can never be mistaken for an
 * upstream classification (and the checker rejects any collision with a
 * real upstream capability value).
 */
export const LOCAL_EXTENSION_STATUS = "local-extension" as const;
export type LocalExtensionStatus = typeof LOCAL_EXTENSION_STATUS;

export interface CompatibilityClassification {
	/** Upstream APICapability value or PulumiRoutes key (or local extension id). */
	readonly id: string;
	readonly status: CompatibilityStatus | LocalExtensionStatus;
	/** Why this classification was chosen; required for audit/review. */
	readonly note: string;
}

// ============================================================================
// Capability policy — exhaustive over pulumi.gen.ts's generated
// `export const X: APICapability = "..."` values (currently 10).
// ============================================================================

const S = CompatibilityStatus;

export const PULUMI_CAPABILITY_POLICY: readonly CompatibilityClassification[] = [
	{
		id: "delta-checkpoint-uploads",
		status: S.IntentionallyUnsupported,
		note: "Deprecated upstream in favor of delta-checkpoint-uploads-v2 (see pulumi.gen.ts doc comment); Procella never advertises the v1 capability.",
	},
	{
		id: "delta-checkpoint-uploads-v2",
		status: S.ImplementedOptIn,
		note: "patchCheckpointDelta is implemented, but advertisement is gated behind an operator setting pending Phase 4 integrity/load-test evidence (default off).",
	},
	{
		id: "batch-encrypt",
		status: S.CoreImplemented,
		note: "batchEncrypt/batchDecrypt routes are implemented and advertised.",
	},
	{
		id: "copilot-summarize-error",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Copilot AI feature; not implemented by the self-hosted backend.",
	},
	{
		id: "copilot-explain-preview",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Copilot AI feature; not implemented by the self-hosted backend.",
	},
	{
		id: "deployment-schema-version",
		status: S.CoreImplemented,
		note: "Advertises deployment schema v1 with configuration.version 3 (PR #244 fixed the wire shape); schema v4 stays unadvertised until round-trip tests prove byte-preserving behavior (Phase 5).",
	},
	{
		id: "stack-policy-packs",
		status: S.IntentionallyUnsupported,
		note: "Policy-as-code administration is a Cloud/Enterprise feature; Procella does not implement policy pack retrieval.",
	},
	{
		id: "api-version",
		status: S.Watching,
		note: "Min/max/default API-version semantics are unverified against the consuming CLI release; advertising it is potentially behavioral (Phase 5). Legacy routes keep working without it.",
	},
	{
		id: "neo-cli-mode",
		status: S.IntentionallyUnsupported,
		note: "Minimum CLI requirements for `pulumi neo`, a Cloud/Copilot-dependent agent feature; not implemented by the self-hosted backend.",
	},
	{
		id: "begin-update",
		status: S.Watching,
		note: "Upstream pkg/backend/httpstate does not yet invoke the combined begin-update endpoint; implement only when a released CLI selects it, keeping create/start as the legacy fallback (Phase 5).",
	},
];

// ============================================================================
// Route policy — exhaustive over routes.gen.ts's generated PulumiRoutes keys
// (currently 59).
// ============================================================================

export const PULUMI_ROUTE_POLICY: readonly CompatibilityClassification[] = [
	// --- Core CLI protocol: login, stacks, updates, checkpoints, crypto -------
	{
		id: "getCapabilities",
		status: S.CoreImplemented,
		note: "Capability negotiation; core protocol entry point.",
	},
	{ id: "getCurrentUser", status: S.CoreImplemented, note: "`pulumi login` identity check." },
	{
		id: "listUserStacks",
		status: S.CoreImplemented,
		note: "`pulumi stack ls` across the caller's stacks.",
	},
	{
		id: "getDefaultOrg",
		status: S.CoreImplemented,
		note: "Default-org lookup on login; served by the org handler.",
	},
	{
		id: "listOrganizationStacks",
		status: S.IntentionallyUnsupported,
		note: "Verified absent: neither apps/server/src/routes/index.ts nor cli.ts registers a GET route with the org-only shape /api/stacks/:org (only /api/stacks and /api/stacks/:org/:project/:stack exist).",
	},
	{
		id: "createStack",
		status: S.IntentionallyUnsupported,
		note: "Verified absent: upstream CreateStack is POST /api/stacks/{orgName} (project+stack in body); Procella instead registers POST /api/stacks/:org/:project and /api/stacks/:org/:project/:stack, a different URL shape the CLI's literal request never matches.",
	},
	{ id: "deleteStack", status: S.CoreImplemented, note: "`pulumi stack rm`." },
	{ id: "getStack", status: S.CoreImplemented, note: "Stack lookup, used throughout the CLI." },
	{ id: "exportStack", status: S.CoreImplemented, note: "`pulumi stack export`." },
	{ id: "importStack", status: S.CoreImplemented, note: "`pulumi stack import`." },
	{ id: "encryptValue", status: S.CoreImplemented, note: "Single-value config encryption." },
	{ id: "decryptValue", status: S.CoreImplemented, note: "Single-value config decryption." },
	{
		id: "getStackLogs",
		status: S.IntentionallyUnsupported,
		note: "Verified absent: no GET /api/stacks/:org/:project/:stack/logs registration in apps/server/src/routes/index.ts or cli.ts.",
	},
	{ id: "getStackUpdates", status: S.CoreImplemented, note: "`pulumi history`." },
	{
		id: "getLatestStackUpdate",
		status: S.IntentionallyUnsupported,
		note: "Verified absent: no GET .../updates/latest registration; only .../updates (getStackUpdates) and .../update/:updateId (literal kind=update) are registered.",
	},
	{
		id: "getStackUpdate",
		status: S.IntentionallyUnsupported,
		note: "Verified absent: no GET .../updates/:version registration in either server route assembler.",
	},
	{
		id: "getUpdateContentsFiles",
		status: S.IntentionallyUnsupported,
		note: "Verified absent: no GET .../updates/:version/contents/files registration in either server route assembler.",
	},
	{
		id: "getUpdateContentsFilePath",
		status: S.IntentionallyUnsupported,
		note: "Verified absent: no GET .../updates/:version/contents/file/:path registration in either server route assembler.",
	},
	{
		id: "batchDecrypt",
		status: S.CoreImplemented,
		note: "Batch config decryption (batch-encrypt capability).",
	},
	{
		id: "batchEncrypt",
		status: S.CoreImplemented,
		note: "Batch config encryption (batch-encrypt capability).",
	},
	{
		id: "projectExists",
		status: S.IntentionallyUnsupported,
		note: "Verified absent: no HEAD /api/stacks/:org/:project registration in either server route assembler.",
	},
	{ id: "renameStack", status: S.CoreImplemented, note: "`pulumi stack rename`." },
	{ id: "updateStackTags", status: S.CoreImplemented, note: "Stack tag metadata updates." },
	{
		id: "updateStackConfig",
		status: S.IntentionallyUnsupported,
		note: "Verified absent: no PUT .../config registration in either server route assembler.",
	},
	{ id: "createDestroy", status: S.CoreImplemented, note: "`pulumi destroy`." },
	{ id: "createPreview", status: S.CoreImplemented, note: "`pulumi preview`." },
	{ id: "createUpdate", status: S.CoreImplemented, note: "`pulumi up` / `pulumi refresh`." },
	{
		id: "getUpdateStatus",
		status: S.CoreImplemented,
		note: "Pulumi uses the literal kind=update status path for preview, update, refresh, and destroy; all four lifecycle kinds are covered by E2E tests.",
	},
	{
		id: "startUpdate",
		status: S.CoreImplemented,
		note: "Pulumi uses the literal kind=update start path after creating preview, update, refresh, and destroy operations; all four lifecycle kinds are covered by E2E tests.",
	},
	{ id: "patchCheckpoint", status: S.CoreImplemented, note: "Full checkpoint upload." },
	{
		id: "patchCheckpointDelta",
		status: S.CoreImplemented,
		note: "checkpointdelta is implemented (see delta-checkpoint-uploads-v2 in PULUMI_CAPABILITY_POLICY for its opt-in advertisement status).",
	},
	{ id: "patchCheckpointVerbatim", status: S.CoreImplemented, note: "Verbatim checkpoint upload." },
	{ id: "completeUpdate", status: S.CoreImplemented, note: "Update lifecycle completion." },
	{
		id: "postEngineEvent",
		status: S.IntentionallyUnsupported,
		note: "Verified absent: only the batch variant (postEngineEventBatch) is registered; the singular POST .../events endpoint has no route.",
	},
	{
		id: "postEngineEventBatch",
		status: S.CoreImplemented,
		note: "Batched engine-event ingestion.",
	},
	{
		id: "patchJournalEntries",
		status: S.CoreImplemented,
		note: "Journal entry negotiation via StartUpdateRequest/Response journalVersion (see journaling-v1 local extension).",
	},
	{
		id: "renewLease",
		status: S.CoreImplemented,
		note: "Update lease renewal for long-running operations.",
	},

	// --- Pulumi Cloud-only / enterprise-only surfaces -------------------------
	{
		id: "listOrganizationMembers",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Cloud org/team membership management; Procella's org membership is owned by its own auth model.",
	},
	{
		id: "listTemplates",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Cloud org template catalog; not implemented.",
	},
	{
		id: "downloadTemplates",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Cloud org template catalog; not implemented.",
	},
	{
		id: "updateDeploymentSettings",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Deployments (Cloud-only continuous deployment product); not implemented.",
	},
	{
		id: "encryptDeploymentSecret",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Deployments; not implemented.",
	},
	{
		id: "destroyDeploymentSettings",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Deployments; not implemented.",
	},
	{
		id: "listStackDeployments",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Deployments; not implemented.",
	},
	{
		id: "cancelStackDeployment",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Deployments; not implemented.",
	},
	{
		id: "getGHAppIntegration",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Cloud console's GitHub App integration; distinct from Procella's own GitHub webhook integration, not implemented.",
	},
	{
		id: "publishPolicyPack",
		status: S.IntentionallyUnsupported,
		note: "Policy-as-code administration (Cloud/Enterprise); not implemented.",
	},
	{
		id: "completePolicyPackPublish",
		status: S.IntentionallyUnsupported,
		note: "Policy-as-code administration (Cloud/Enterprise); not implemented.",
	},
	{
		id: "getUsageSummaryResourceHours",
		status: S.IntentionallyUnsupported,
		note: "Cloud usage/billing summary; not implemented.",
	},
	{
		id: "getSearchResources",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Insights resource search; not implemented.",
	},
	{
		id: "getSearchResourcesParse",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Insights resource search; not implemented.",
	},
	{
		id: "getOrgResourceSearchV2",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Insights resource search; not implemented.",
	},
	{
		id: "listInsightsAccounts",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Insights; not implemented.",
	},
	{
		id: "getScanLogs",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Insights; not implemented.",
	},
	{
		id: "publishPackage",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Cloud package registry publishing; not implemented.",
	},
	{
		id: "completePackagePublish",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Cloud package registry publishing; not implemented.",
	},
	{
		id: "deletePackageVersion",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Cloud package registry; not implemented.",
	},
	{
		id: "publishTemplate",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Cloud template registry publishing; not implemented.",
	},
	{
		id: "completeTemplatePublish",
		status: S.IntentionallyUnsupported,
		note: "Pulumi Cloud template registry publishing; not implemented.",
	},
];

// ============================================================================
// Local extensions — Procella protocol additions that are NOT upstream
// APICapability values. Never merged into PULUMI_CAPABILITY_POLICY: the
// checker rejects any local extension id that collides with an upstream
// capability value.
// ============================================================================

export const LOCAL_CAPABILITY_EXTENSIONS: readonly CompatibilityClassification[] = [
	{
		id: "journaling-v1",
		status: LOCAL_EXTENSION_STATUS,
		note: "Procella-only capability advertisement for journal-entry negotiation; not part of the upstream Pulumi apitype capability set (see pulumi.ts JournalEntry types, mirrored from journal.go which tygo does not generate).",
	},
];

// ============================================================================
// Manifest validation — pure, fail-closed comparison of a generated upstream
// inventory against the classification arrays above.
// ============================================================================

export interface CompatibilityInventory {
	/** Every APICapability value currently generated into pulumi.gen.ts. */
	readonly capabilities: readonly string[];
	/** Every PulumiRoutes key currently generated into routes.gen.ts. */
	readonly routes: readonly string[];
}

export interface CompatibilityManifest {
	readonly capabilityPolicy: readonly CompatibilityClassification[];
	readonly routePolicy: readonly CompatibilityClassification[];
	readonly localCapabilityExtensions: readonly CompatibilityClassification[];
}

/** The real, hand-maintained policy. Callers normally rely on the default. */
export const DEFAULT_COMPATIBILITY_MANIFEST: CompatibilityManifest = {
	capabilityPolicy: PULUMI_CAPABILITY_POLICY,
	routePolicy: PULUMI_ROUTE_POLICY,
	localCapabilityExtensions: LOCAL_CAPABILITY_EXTENSIONS,
};

const VALID_STATUSES: Record<string, true> = Object.fromEntries(
	Object.values(CompatibilityStatus).map((status) => [status, true] as const),
);

function analyzeInventory(
	kind: "capability" | "route",
	upstreamIds: readonly string[],
	entries: readonly CompatibilityClassification[],
): string[] {
	const errors: string[] = [];
	const counts = new Map<string, number>();
	for (const entry of entries) {
		counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
	}
	for (const [id, count] of counts) {
		if (count > 1) {
			errors.push(`duplicate ${kind} classification: "${id}" appears ${count} times`);
		}
	}

	const classifiedIds = new Set(entries.map((entry) => entry.id));
	const upstreamSet = new Set(upstreamIds);

	for (const id of upstreamIds) {
		if (!classifiedIds.has(id)) {
			errors.push(
				`missing ${kind} classification: "${id}" is generated upstream but has no policy entry`,
			);
		}
	}
	for (const id of classifiedIds) {
		if (!upstreamSet.has(id)) {
			errors.push(
				`extra ${kind} classification: "${id}" has a policy entry but is not present in the generated upstream inventory`,
			);
		}
	}

	for (const entry of entries) {
		if (!Object.hasOwn(VALID_STATUSES, entry.status)) {
			errors.push(`invalid ${kind} classification status "${entry.status}" for "${entry.id}"`);
		}
	}

	return errors;
}

/**
 * Fail-closed comparison of the generated upstream inventory against the
 * compatibility manifest. Returns an empty array when every upstream
 * capability/route has exactly one valid classification, every local
 * extension is well-formed, and nothing extra/duplicate/malformed exists.
 */
export function validateCompatibilityManifest(
	inventory: CompatibilityInventory,
	manifest: CompatibilityManifest = DEFAULT_COMPATIBILITY_MANIFEST,
): string[] {
	const errors: string[] = [];

	errors.push(...analyzeInventory("capability", inventory.capabilities, manifest.capabilityPolicy));
	errors.push(...analyzeInventory("route", inventory.routes, manifest.routePolicy));

	const localCounts = new Map<string, number>();
	for (const entry of manifest.localCapabilityExtensions) {
		localCounts.set(entry.id, (localCounts.get(entry.id) ?? 0) + 1);

		if (entry.status !== LOCAL_EXTENSION_STATUS) {
			errors.push(
				`local capability extension "${entry.id}" must use status "${LOCAL_EXTENSION_STATUS}", got "${entry.status}"`,
			);
		}
		if (inventory.capabilities.includes(entry.id)) {
			errors.push(
				`local capability extension "${entry.id}" collides with an upstream APICapability value; it must be classified in PULUMI_CAPABILITY_POLICY instead`,
			);
		}
	}
	for (const [id, count] of localCounts) {
		if (count > 1) {
			errors.push(
				`duplicate local capability extension classification: "${id}" appears ${count} times`,
			);
		}
	}

	return errors;
}

// ============================================================================
// Lookup helpers for later workers (runtime + CI) to consume.
// ============================================================================

/** Returns the classification status for an upstream capability value or a
 * known local extension id, or `undefined` if unclassified. */
export function capabilityStatus(
	capability: string,
): CompatibilityStatus | LocalExtensionStatus | undefined {
	return (
		PULUMI_CAPABILITY_POLICY.find((entry) => entry.id === capability)?.status ??
		LOCAL_CAPABILITY_EXTENSIONS.find((entry) => entry.id === capability)?.status
	);
}

/** Returns the classification status for an upstream PulumiRoutes key, or
 * `undefined` if unclassified. */
export function routeStatus(route: string): CompatibilityStatus | undefined {
	const found = PULUMI_ROUTE_POLICY.find((entry) => entry.id === route);
	return found?.status as CompatibilityStatus | undefined;
}
