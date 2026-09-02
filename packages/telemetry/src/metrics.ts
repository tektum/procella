import { type Counter, type Histogram, metrics, type UpDownCounter } from "@opentelemetry/api";
import { PULUMI_FULLY_SUPPORTED_MIN_VERSION } from "@procella/types";

let httpDuration: Histogram | null = null;
let httpActiveRequests: UpDownCounter | null = null;
let dbDuration: Histogram | null = null;
let dbOpsCounter: Counter | null = null;
let cryptoOps: Counter | null = null;
let gcCycles: Counter | null = null;
let gcOrphansCleaned: Counter | null = null;
let activeUpdates: UpDownCounter | null = null;
let checkpointSizeBytes: Histogram | null = null;
let journalEntriesCounter: Counter | null = null;

function getMeter() {
	return metrics.getMeter("procella");
}

export function httpRequestDuration(): Histogram {
	if (!httpDuration)
		httpDuration = getMeter().createHistogram("http.server.request.duration", { unit: "ms" });
	return httpDuration;
}

export function httpActiveRequestsGauge(): UpDownCounter {
	if (!httpActiveRequests)
		httpActiveRequests = getMeter().createUpDownCounter("http.server.active_requests");
	return httpActiveRequests;
}

export function dbOperationDuration(): Histogram {
	if (!dbDuration)
		dbDuration = getMeter().createHistogram("db.client.operation.duration", { unit: "ms" });
	return dbDuration;
}

export function dbOperationCount(): Counter {
	if (!dbOpsCounter) dbOpsCounter = getMeter().createCounter("db.client.operation.count");
	return dbOpsCounter;
}

export function cryptoOperationCount(): Counter {
	if (!cryptoOps) cryptoOps = getMeter().createCounter("procella.crypto.operations");
	return cryptoOps;
}

export function gcCycleCount(): Counter {
	if (!gcCycles) gcCycles = getMeter().createCounter("procella.gc.cycles");
	return gcCycles;
}

export function gcOrphansCleanedCount(): Counter {
	if (!gcOrphansCleaned) gcOrphansCleaned = getMeter().createCounter("procella.gc.orphans_cleaned");
	return gcOrphansCleaned;
}

export function activeUpdatesGauge(): UpDownCounter {
	if (!activeUpdates) activeUpdates = getMeter().createUpDownCounter("procella.updates.active");
	return activeUpdates;
}

export function checkpointSizeHistogram(): Histogram {
	if (!checkpointSizeBytes)
		checkpointSizeBytes = getMeter().createHistogram("procella.checkpoint.size_bytes", {
			unit: "By",
		});
	return checkpointSizeBytes;
}

export function journalEntriesCount(): Counter {
	if (!journalEntriesCounter)
		journalEntriesCounter = getMeter().createCounter("procella.journal.entries");
	return journalEntriesCounter;
}

let storageDuration: Histogram | null = null;
let storageSizeBytes: Histogram | null = null;
let authDuration: Histogram | null = null;
let authFailures: Counter | null = null;
let trpcDuration: Histogram | null = null;

export function storageOperationDuration(): Histogram {
	if (!storageDuration)
		storageDuration = getMeter().createHistogram("procella.storage.operation.duration", {
			unit: "ms",
		});
	return storageDuration;
}

export function storageOperationSize(): Histogram {
	if (!storageSizeBytes)
		storageSizeBytes = getMeter().createHistogram("procella.storage.operation.size_bytes", {
			unit: "By",
		});
	return storageSizeBytes;
}

export function authAuthenticateDuration(): Histogram {
	if (!authDuration)
		authDuration = getMeter().createHistogram("procella.auth.duration", { unit: "ms" });
	return authDuration;
}

export function authFailureCount(): Counter {
	if (!authFailures) authFailures = getMeter().createCounter("procella.auth.failures");
	return authFailures;
}

export function trpcProcedureDuration(): Histogram {
	if (!trpcDuration)
		trpcDuration = getMeter().createHistogram("procella.trpc.procedure.duration", { unit: "ms" });
	return trpcDuration;
}

// ============================================================================
// Pulumi client compatibility telemetry
//
// Low-cardinality, operator-local observability into which Pulumi CLI /
// protocol shapes are hitting this server. Attributes are closed buckets plus
// a strictly parsed major/minor; never a raw user agent, patch/prerelease/build
// data, path parameter, stack/org/update id, or token. Disabled the
// same way every other metric here is disabled: when telemetry is off, no
// global meter provider is installed, `getMeter()` resolves to OTel's no-op
// meter, and every `.add()` below becomes a no-op.
// ============================================================================

/** Closed bucket for the Pulumi CLI's reported version, derived from the
 * `User-Agent` header. Never the raw/exact semver — only whether the client
 * is at or above the fully supported minimum. */
export type CompatCliBucket = "legacy-below-supported" | "supported" | "unknown";

/** Closed release-line bucket retaining the two policy anchors without allowing
 * arbitrary User-Agent versions to create unbounded metric cardinality. */
export type CompatCliMajorMinor = "3.9" | "3.233" | "other-legacy" | "other-supported" | "unknown";

/** Closed bucket for the Pulumi API version the client advertised via the
 * `Accept: application/vnd.pulumi+N` header. */
export type CompatApiBucket = "none" | "below-v8" | "v8" | "v9-plus" | "invalid";

/** Closed, coarse classification of the matched route template (never the
 * raw request path with resolved path-parameter values). */
export type CompatRouteClass = "legacy" | "version-gated" | "update" | "state" | "crypto" | "other";

export type CompatResult =
	| "success"
	| "protocol-error"
	| "client-error"
	| "auth-error"
	| "unsupported-version"
	| "server-error";

// Current upstream Pulumi SDK: `pulumi-cli/1 (<semver>; <os>; ...)`. The
// leading "1" is a User-Agent *format* version, not the CLI version — the
// CLI semver is the first parenthesized field, terminated by `;` or `)`.
const CLI_UA_CURRENT_PATTERN = /pulumi-cli\/1\s*\(\s*([^;()]+?)\s*(?:;|\))/i;
// Legacy observed form: `pulumi-cli/<semver>` with no wrapping parens. Capture
// one delimited candidate and let the strictly anchored SemVer parser below be
// the sole validator. This prevents prefix truncation while accepting every
// valid prerelease/build identifier shape.
const CLI_UA_LEGACY_PATTERN = /pulumi-cli\/([^\s;),]+)/i;

function extractCliVersion(userAgent: string | undefined | null): string | null {
	if (!userAgent) return null;
	const current = CLI_UA_CURRENT_PATTERN.exec(userAgent);
	if (current?.[1]) return current[1].trim();
	const legacy = CLI_UA_LEGACY_PATTERN.exec(userAgent);
	return legacy?.[1] ?? null;
}

// Strictly anchored (^...$) SemVer 2.0.0 grammar (https://semver.org), with
// the patch component made optional (defaults to 0) to accept the legacy
// `<major>.<minor>` shape some older Pulumi CLI User-Agents send. A loose
// prefix-style regex would accept things it must not:
//   - "3.233.0evil"        — garbage directly appended, no "-"/"+" separator
//   - "3.233.0-" / "...+"  — an empty prerelease/build suffix
//   - "3.233.0-beta..1"    — an empty dot-separated identifier
//   - "3.03.0" / "...-01"  — a leading zero in a numeric identifier
// It still accepts combined prerelease + build metadata, e.g.
// "3.233.0-beta.1+build.7". Numeric-identifier alternatives ("0|[1-9]\d*")
// reject leading zeros; build identifiers have no such restriction, per spec.
const SEMVER_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

function parseSemverTuple(version: string): [number, number, number] | null {
	const match = SEMVER_PATTERN.exec(version);
	if (!match) return null;
	const tuple: [number, number, number] = [
		Number.parseInt(match[1], 10),
		Number.parseInt(match[2], 10),
		match[3] ? Number.parseInt(match[3], 10) : 0,
	];
	return tuple.every(Number.isSafeInteger) ? tuple : null;
}

function compareSemverTuples(a: [number, number, number], b: [number, number, number]): number {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

interface CliCompatibility {
	bucket: CompatCliBucket;
	majorMinor: CompatCliMajorMinor;
}

function classifyCliCompatibility(userAgent: string | undefined | null): CliCompatibility {
	const version = extractCliVersion(userAgent);
	const tuple = version ? parseSemverTuple(version) : null;
	const minimum = parseSemverTuple(PULUMI_FULLY_SUPPORTED_MIN_VERSION);
	if (!tuple || !minimum) return { bucket: "unknown", majorMinor: "unknown" };
	const bucket = compareSemverTuples(tuple, minimum) >= 0 ? "supported" : "legacy-below-supported";
	let majorMinor: CompatCliMajorMinor = bucket === "supported" ? "other-supported" : "other-legacy";
	if (tuple[0] === 3 && tuple[1] === 9) majorMinor = "3.9";
	if (tuple[0] === 3 && tuple[1] === 233) majorMinor = "3.233";
	return { bucket, majorMinor };
}

/** Classify a Pulumi CLI `User-Agent` header into a closed support bucket. */
export function classifyCliVersion(userAgent: string | undefined | null): CompatCliBucket {
	return classifyCliCompatibility(userAgent).bucket;
}

/** Return a closed release-line bucket after strict SemVer parsing. Patch,
 * prerelease, build metadata, and all other raw User-Agent content are discarded. */
export function classifyCliMajorMinor(userAgent: string | undefined | null): CompatCliMajorMinor {
	return classifyCliCompatibility(userAgent).majorMinor;
}

// Mirrors apps/server/src/middleware/pulumi-accept.ts's media-range parsing
// (RFC 9110 §12.5.1 allows multiple ranges per Accept header) without
// depending on that package — this stays a pure, self-contained classifier.
const PULUMI_ACCEPT_ATTEMPT_PATTERN = /application\/vnd\.pulumi\b/i;
const PULUMI_ACCEPT_VERSION_PATTERN = /application\/vnd\.pulumi\+(\d+)(?=\s*(?:[;,]|$))/gi;

/** Classify an `Accept` header into a closed Pulumi API-version bucket.
 * "none" means no Pulumi media range was advertised at all (the common case
 * for non-CLI/dashboard traffic); "invalid" means a Pulumi media range was
 * attempted but didn't parse to a version number. */
export function classifyApiVersion(accept: string | undefined | null): CompatApiBucket {
	if (!accept || !PULUMI_ACCEPT_ATTEMPT_PATTERN.test(accept)) return "none";
	const versions = Array.from(accept.matchAll(PULUMI_ACCEPT_VERSION_PATTERN), (m) =>
		Number.parseInt(m[1], 10),
	).filter(Number.isFinite);
	if (versions.length === 0) return "invalid";
	const max = Math.max(...versions);
	if (max < 8) return "below-v8";
	if (max === 8) return "v8";
	return "v9-plus";
}

// Classification is pattern-based over the *matched route template* (e.g.
// "/api/stacks/:org/:project/:stack/encrypt") as resolved by Hono's router —
// never the raw request path with resolved parameter values. Order matters:
// more specific classes are checked before the "legacy" catch-all, and
// version-gated routes are checked before the crypto/update classes they'd
// otherwise also match.
const VERSION_GATED_ROUTE_PATTERN = /batch-encrypt|batch-decrypt|checkpointdelta/i;
const CRYPTO_ROUTE_PATTERN = /\b(?:encrypt|decrypt|decryption)\b/i;
const STATE_ROUTE_PATTERN = /\/(?:export|import)(?:\/|$)/i;
const UPDATE_ROUTE_PATTERN =
	/:updateid|\bupdates?\b|checkpoint|journalentries|renew_lease|\bevents\b|\bcancel\b|\bcomplete\b/i;
const LEGACY_ROUTE_PATTERN = /^\/api\/(?:stacks(?:\/|$)|user(?:\/|$)|capabilities$|cli\/version$)/i;
// CreateUpdate's registered handler is a bare `:kind` catch-all segment
// (`POST /api/stacks/:org/:project/:stack/:kind`, dispatching on the runtime
// value of `:kind` being "update"/"preview"/"refresh"/"destroy") — it has no
// literal "update" substring in its route template, so UPDATE_ROUTE_PATTERN
// can never match it. Listed as an exact static lookup (not a broad regex)
// so it can never accidentally reclassify an unrelated route that merely
// ends in a single trailing param segment (e.g. stack tags/rename keep
// their own distinct literal last segment and are unaffected). Includes
// both the fully-mounted form and the sub-router-relative form (some Hono
// compositions report routePath without the "/api" mount prefix).
const CREATE_UPDATE_ROUTE_TEMPLATES: Record<string, true> = {
	"/api/stacks/:org/:project/:stack/:kind": true,
	"/stacks/:org/:project/:stack/:kind": true,
};

/** Classify a matched route template into a closed, coarse route class.
 * Anything outside the CLI's core protocol surface (health checks, the web
 * dashboard's tRPC API, ESC, webhooks, OAuth, admin routes) is "other". */
export function classifyRouteClass(routePattern: string | undefined | null): CompatRouteClass {
	const pattern = routePattern && routePattern !== "/*" ? routePattern : "/*";
	if (CREATE_UPDATE_ROUTE_TEMPLATES[pattern]) return "update";
	if (VERSION_GATED_ROUTE_PATTERN.test(pattern)) return "version-gated";
	if (CRYPTO_ROUTE_PATTERN.test(pattern)) return "crypto";
	if (STATE_ROUTE_PATTERN.test(pattern)) return "state";
	if (UPDATE_ROUTE_PATTERN.test(pattern)) return "update";
	if (LEGACY_ROUTE_PATTERN.test(pattern)) return "legacy";
	return "other";
}

/** Classify an HTTP response status into a closed outcome class. Protocol
 * validation (400) and state/sequence conflicts (409) are separated from
 * generic client errors; 415 remains the version-negotiation class. */
export function classifyResult(status: number): CompatResult {
	if (status >= 500) return "server-error";
	if (status === 415) return "unsupported-version";
	if (status === 401 || status === 403) return "auth-error";
	if (status === 400 || status === 409) return "protocol-error";
	if (status >= 400) return "client-error";
	return "success";
}

let compatRequestCounter: Counter | null = null;

/** Low-cardinality Pulumi client compatibility request counter. Attributes
 * are closed buckets except for the bounded major/minor version dimension. */
export function compatibilityRequestCount(): Counter {
	if (!compatRequestCounter)
		compatRequestCounter = getMeter().createCounter("procella.compat.http_requests");
	return compatRequestCounter;
}

export interface CompatibilityRequestInput {
	userAgent: string | undefined | null;
	accept: string | undefined | null;
	routePattern: string | undefined | null;
	status: number;
}

/** Record one compatibility request observation. Never attaches stack/org/
 * update ids, the raw user agent, a token, patch/prerelease version data, or a
 * path-parameter value. */
export function recordCompatibilityRequest(input: CompatibilityRequestInput): void {
	const cli = classifyCliCompatibility(input.userAgent);
	compatibilityRequestCount().add(1, {
		"procella.compat.cli_bucket": cli.bucket,
		"procella.compat.cli_major_minor": cli.majorMinor,
		"procella.compat.api_bucket": classifyApiVersion(input.accept),
		"procella.compat.route_class": classifyRouteClass(input.routePattern),
		"procella.compat.result": classifyResult(input.status),
	});
}
