import { describe, expect, test } from "bun:test";
import {
	activeUpdatesGauge,
	authAuthenticateDuration,
	authFailureCount,
	type CompatApiBucket,
	type CompatCliBucket,
	type CompatCliMajorMinor,
	type CompatResult,
	type CompatRouteClass,
	checkpointSizeHistogram,
	classifyApiVersion,
	classifyCliMajorMinor,
	classifyCliVersion,
	classifyResult,
	classifyRouteClass,
	compatibilityRequestCount,
	cryptoOperationCount,
	dbOperationCount,
	dbOperationDuration,
	gcCycleCount,
	gcOrphansCleanedCount,
	httpActiveRequestsGauge,
	httpRequestDuration,
	journalEntriesCount,
	recordCompatibilityRequest,
	storageOperationDuration,
	storageOperationSize,
	trpcProcedureDuration,
} from "./metrics.js";

describe("@procella/telemetry metrics", () => {
	test("httpRequestDuration returns a Histogram", () => {
		const h = httpRequestDuration();
		expect(h).toBeDefined();
		expect(typeof h.record).toBe("function");
	});

	test("httpActiveRequestsGauge returns an UpDownCounter", () => {
		const c = httpActiveRequestsGauge();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("dbOperationDuration returns a Histogram", () => {
		const h = dbOperationDuration();
		expect(h).toBeDefined();
		expect(typeof h.record).toBe("function");
	});

	test("dbOperationCount returns a Counter", () => {
		const c = dbOperationCount();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("cryptoOperationCount returns a Counter", () => {
		const c = cryptoOperationCount();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("gcCycleCount returns a Counter", () => {
		const c = gcCycleCount();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("gcOrphansCleanedCount returns a Counter", () => {
		const c = gcOrphansCleanedCount();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("activeUpdatesGauge returns an UpDownCounter", () => {
		const c = activeUpdatesGauge();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("checkpointSizeHistogram returns a Histogram", () => {
		const h = checkpointSizeHistogram();
		expect(h).toBeDefined();
		expect(typeof h.record).toBe("function");
	});

	test("journalEntriesCount returns a Counter", () => {
		const c = journalEntriesCount();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("storageOperationDuration returns a Histogram", () => {
		const h = storageOperationDuration();
		expect(h).toBeDefined();
		expect(typeof h.record).toBe("function");
	});

	test("storageOperationSize returns a Histogram", () => {
		const h = storageOperationSize();
		expect(h).toBeDefined();
		expect(typeof h.record).toBe("function");
	});

	test("authAuthenticateDuration returns a Histogram", () => {
		const h = authAuthenticateDuration();
		expect(h).toBeDefined();
		expect(typeof h.record).toBe("function");
	});

	test("authFailureCount returns a Counter", () => {
		const c = authFailureCount();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
	});

	test("trpcProcedureDuration returns a Histogram", () => {
		const h = trpcProcedureDuration();
		expect(h).toBeDefined();
		expect(typeof h.record).toBe("function");
	});

	test("all metric factories are singletons (return same instance)", () => {
		expect(httpRequestDuration()).toBe(httpRequestDuration());
		expect(dbOperationCount()).toBe(dbOperationCount());
		expect(gcCycleCount()).toBe(gcCycleCount());
		expect(activeUpdatesGauge()).toBe(activeUpdatesGauge());
		expect(trpcProcedureDuration()).toBe(trpcProcedureDuration());
	});

	test("metrics accept recording without error", () => {
		httpRequestDuration().record(42.5, { method: "GET", path: "/test", status: 200 });
		dbOperationCount().add(1, { "db.operation": "select" });
		activeUpdatesGauge().add(1);
		activeUpdatesGauge().add(-1);
		checkpointSizeHistogram().record(1024);
		// No assertions — just verifying no runtime errors
	});
});

describe("classifyCliVersion", () => {
	const CLI_BUCKETS: readonly CompatCliBucket[] = [
		"legacy-below-supported",
		"supported",
		"unknown",
	];

	test("current upstream UA shape below the supported floor is legacy-below-supported", () => {
		expect(classifyCliVersion("pulumi-cli/1 (3.100.0; linux)")).toBe("legacy-below-supported");
	});

	test("current upstream UA shape at/above the supported floor is supported", () => {
		expect(classifyCliVersion("pulumi-cli/1 (3.233.0; darwin)")).toBe("supported");
		expect(classifyCliVersion("pulumi-cli/1 (3.250.2; windows)")).toBe("supported");
	});

	test("legacy observed UA shape (no parens/os) is parsed", () => {
		expect(classifyCliVersion("pulumi-cli/3.100")).toBe("legacy-below-supported");
		expect(classifyCliVersion("pulumi-cli/3.233.0")).toBe("supported");
	});

	test("boundary versions around the fully-supported minimum (3.233.0)", () => {
		expect(classifyCliVersion("pulumi-cli/3.232.9")).toBe("legacy-below-supported");
		expect(classifyCliVersion("pulumi-cli/3.233.0")).toBe("supported");
		expect(classifyCliVersion("pulumi-cli/3.233.1")).toBe("supported");
	});

	test("malformed trailing suffix directly appended to the version (no valid separator) is unknown, not supported", () => {
		// "evil" is appended with no "-" or "+" separator, so this is not a
		// syntactically valid semver — must never be truncated/prefix-matched
		// into a valid "3.233.0" and misclassified as supported.
		expect(classifyCliVersion("pulumi-cli/1 (3.233.0evil; linux)")).toBe("unknown");
		expect(classifyCliVersion("pulumi-cli/3.233.0evil")).toBe("unknown");
	});

	test("valid prerelease/build metadata suffixes are still parsed", () => {
		// "-" and "+" are legitimate semver prerelease/build separators and
		// must remain supported, unlike a bare appended suffix.
		expect(classifyCliVersion("pulumi-cli/1 (3.233.0-beta.1; linux)")).toBe("supported");
		expect(classifyCliVersion("pulumi-cli/3.233.0-beta.1")).toBe("supported");
		expect(classifyCliVersion("pulumi-cli/1 (3.9.0-rc.1; linux)")).toBe("legacy-below-supported");
		expect(classifyCliVersion("pulumi-cli/3.233.0+build.123")).toBe("supported");
	});

	test("empty prerelease/build suffix is unknown, not truncated to the bare version", () => {
		expect(classifyCliVersion("pulumi-cli/3.233.0-")).toBe("unknown");
		expect(classifyCliVersion("pulumi-cli/3.233.0+")).toBe("unknown");
		expect(classifyCliVersion("pulumi-cli/1 (3.233.0-; linux)")).toBe("unknown");
		expect(classifyCliVersion("pulumi-cli/1 (3.233.0+; linux)")).toBe("unknown");
	});

	test("empty dot-separated prerelease identifier is unknown", () => {
		expect(classifyCliVersion("pulumi-cli/3.233.0-beta..1")).toBe("unknown");
		expect(classifyCliVersion("pulumi-cli/1 (3.233.0-beta..1; linux)")).toBe("unknown");
	});

	test("leading zeros in numeric core identifiers are unknown", () => {
		expect(classifyCliVersion("pulumi-cli/3.03.0")).toBe("unknown");
		expect(classifyCliVersion("pulumi-cli/03.233.0")).toBe("unknown");
		expect(classifyCliVersion("pulumi-cli/3.233.00")).toBe("unknown");
		expect(classifyCliVersion("pulumi-cli/1 (3.233.00; linux)")).toBe("unknown");
	});

	test("leading zeros in numeric prerelease identifiers are unknown", () => {
		expect(classifyCliVersion("pulumi-cli/3.233.0-01")).toBe("unknown");
		expect(classifyCliVersion("pulumi-cli/1 (3.233.0-01; linux)")).toBe("unknown");
	});

	test("combined prerelease and build metadata is accepted", () => {
		expect(classifyCliVersion("pulumi-cli/3.233.0-beta.1+build.7")).toBe("supported");
		expect(classifyCliVersion("pulumi-cli/1 (3.233.0-beta.1+build.7; linux)")).toBe("supported");
		// Build identifiers have no leading-zero restriction per SemVer.
		expect(classifyCliVersion("pulumi-cli/3.233.0-beta.1+007")).toBe("supported");
	});

	test("absent user agent is unknown", () => {
		expect(classifyCliVersion(undefined)).toBe("unknown");
		expect(classifyCliVersion(null)).toBe("unknown");
		expect(classifyCliVersion("")).toBe("unknown");
	});

	test("non-Pulumi user agent is unknown", () => {
		expect(classifyCliVersion("Mozilla/5.0 (Macintosh) AppleWebKit/537.36")).toBe("unknown");
	});

	test("malformed pulumi-cli user agent is unknown, never throws", () => {
		expect(classifyCliVersion("pulumi-cli/1 (nonsense)")).toBe("unknown");
		expect(classifyCliVersion("pulumi-cli/1")).toBe("unknown");
		expect(classifyCliVersion("pulumi-cli/")).toBe("unknown");
		expect(classifyCliVersion("pulumi-cli")).toBe("unknown");
	});

	test("never leaks the raw user agent into the returned bucket", () => {
		const secretLikeUa = "pulumi-cli/1 (3.9.0; linux) token=super-secret-value";
		const bucket = classifyCliVersion(secretLikeUa);
		expect(CLI_BUCKETS).toContain(bucket);
		expect(bucket).not.toContain("secret");
		expect(bucket).not.toContain("3.9.0");
	});
});

describe("classifyCliMajorMinor", () => {
	test("retains only the two policy release-line anchors", () => {
		expect(classifyCliMajorMinor("pulumi-cli/1 (3.9.7; linux)")).toBe("3.9");
		expect(classifyCliMajorMinor("pulumi-cli/3.233")).toBe("3.233");
		expect(classifyCliMajorMinor("pulumi-cli/3.232.99")).toBe("other-legacy");
		expect(classifyCliMajorMinor("pulumi-cli/3.259.7")).toBe("other-supported");
	});

	test("strictly validates SemVer before discarding prerelease and build fields", () => {
		expect(classifyCliMajorMinor("pulumi-cli/3.233.0-beta-1.2+build.007")).toBe("3.233");
		expect(classifyCliMajorMinor("pulumi-cli/3.233.0evil")).toBe("unknown");
		expect(classifyCliMajorMinor("pulumi-cli/3.233.0-beta..1")).toBe("unknown");
		expect(classifyCliMajorMinor("pulumi-cli/3.233.00")).toBe("unknown");
	});

	test("rejects unsafe numeric components instead of creating attacker-controlled labels", () => {
		expect(classifyCliMajorMinor("pulumi-cli/9007199254740992.1.0")).toBe("unknown");
		expect(classifyCliMajorMinor("pulumi-cli/3.9007199254740992.0")).toBe("unknown");
	});

	test("10,000 distinct valid user agents produce only four non-unknown buckets", () => {
		const buckets = new Set<CompatCliMajorMinor>();
		for (let index = 0; index < 10_000; index++) {
			const major = Math.floor(index / 1000);
			const minor = index % 1000;
			buckets.add(classifyCliMajorMinor(`pulumi-cli/${major}.${minor}.${index}`));
		}
		expect(buckets).toEqual(new Set(["3.9", "3.233", "other-legacy", "other-supported"]));
	});

	test("never returns patch, prerelease, build, or raw user-agent data", () => {
		const value: CompatCliMajorMinor = classifyCliMajorMinor(
			"pulumi-cli/1 (3.259.7-beta.1+build.9; linux) token=secret",
		);
		expect(value).toBe("other-supported");
		expect(value).not.toContain(".7");
		expect(value).not.toContain("beta");
		expect(value).not.toContain("secret");
	});
});

describe("classifyApiVersion", () => {
	const API_BUCKETS: readonly CompatApiBucket[] = ["none", "below-v8", "v8", "v9-plus", "invalid"];

	test("absent Accept header is none", () => {
		expect(classifyApiVersion(undefined)).toBe("none");
		expect(classifyApiVersion(null)).toBe("none");
		expect(classifyApiVersion("")).toBe("none");
	});

	test("non-Pulumi Accept header is none", () => {
		expect(classifyApiVersion("application/json")).toBe("none");
		expect(classifyApiVersion("text/html, application/xhtml+xml")).toBe("none");
	});

	test("single Pulumi media range is bucketed by version", () => {
		expect(classifyApiVersion("application/vnd.pulumi+7")).toBe("below-v8");
		expect(classifyApiVersion("application/vnd.pulumi+8")).toBe("v8");
		expect(classifyApiVersion("application/vnd.pulumi+9")).toBe("v9-plus");
		expect(classifyApiVersion("application/vnd.pulumi+42")).toBe("v9-plus");
	});

	test("multiple Accept media ranges use the max advertised version", () => {
		expect(classifyApiVersion("application/vnd.pulumi+7, application/vnd.pulumi+9")).toBe(
			"v9-plus",
		);
		expect(classifyApiVersion("application/vnd.pulumi+6, application/vnd.pulumi+7")).toBe(
			"below-v8",
		);
		expect(classifyApiVersion("application/vnd.pulumi+8, application/json")).toBe("v8");
	});

	test("malformed Pulumi media range is invalid, never throws", () => {
		expect(classifyApiVersion("application/vnd.pulumi")).toBe("invalid");
		expect(classifyApiVersion("application/vnd.pulumi+")).toBe("invalid");
		expect(classifyApiVersion("application/vnd.pulumi+abc")).toBe("invalid");
	});

	test("never returns a value outside the closed bucket set", () => {
		for (const accept of [
			"application/vnd.pulumi+8evil",
			"application/vnd.pulumi+8; charset=utf-8",
			"*/*",
		]) {
			expect(API_BUCKETS).toContain(classifyApiVersion(accept));
		}
	});
});

describe("classifyRouteClass", () => {
	const ROUTE_CLASSES: readonly CompatRouteClass[] = [
		"legacy",
		"version-gated",
		"update",
		"state",
		"crypto",
		"other",
	];

	test("version-gated routes (batch crypto, delta checkpoint)", () => {
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/batch-encrypt")).toBe(
			"version-gated",
		);
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/batch-decrypt")).toBe(
			"version-gated",
		);
		expect(
			classifyRouteClass("/api/stacks/:org/:project/:stack/:kind/:updateId/checkpointdelta"),
		).toBe("version-gated");
	});

	test("crypto routes (single encrypt/decrypt/log-decryption)", () => {
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/encrypt")).toBe("crypto");
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/decrypt")).toBe("crypto");
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/log-decryption")).toBe("crypto");
	});

	test("state routes (export/import)", () => {
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/export")).toBe("state");
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/export/:version")).toBe("state");
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/import")).toBe("state");
	});

	test("update lifecycle routes (checkpoint, journal, events, renew_lease, update)", () => {
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/:kind/:updateId/checkpoint")).toBe(
			"update",
		);
		expect(
			classifyRouteClass("/api/stacks/:org/:project/:stack/:kind/:updateId/journalentries"),
		).toBe("update");
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/:kind/:updateId/renew_lease")).toBe(
			"update",
		);
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/update/:updateId")).toBe("update");
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/updates")).toBe("update");
	});

	test("CreateUpdate's bare :kind catch-all is classified as update (exact template match)", () => {
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/:kind")).toBe("update");
		// Mounted-equivalent form without the "/api" prefix.
		expect(classifyRouteClass("/stacks/:org/:project/:stack/:kind")).toBe("update");
	});

	test("exact CreateUpdate template match does not broaden to structurally similar routes", () => {
		// One segment shorter — still plain stack CRUD, must stay legacy.
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack")).toBe("legacy");
		// Same shape but with a distinct literal last segment (not a bare
		// param) — must keep its own classification, not the exact match.
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/tags")).toBe("legacy");
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/rename")).toBe("legacy");
		// A different param name in the trailing slot must not match the
		// exact CreateUpdate template.
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack/:version")).toBe("legacy");
	});

	test("legacy core CLI routes", () => {
		expect(classifyRouteClass("/api/stacks/:org")).toBe("legacy");
		expect(classifyRouteClass("/api/stacks/:org/:project/:stack")).toBe("legacy");
		expect(classifyRouteClass("/api/user")).toBe("legacy");
		expect(classifyRouteClass("/api/user/stacks")).toBe("legacy");
		expect(classifyRouteClass("/api/capabilities")).toBe("legacy");
		expect(classifyRouteClass("/api/cli/version")).toBe("legacy");
	});

	test("non-CLI routes fall back to other", () => {
		expect(classifyRouteClass("/healthz")).toBe("other");
		expect(classifyRouteClass("/api/esc/environments")).toBe("other");
		expect(classifyRouteClass("/api/oauth/token")).toBe("other");
		expect(classifyRouteClass("/trpc/*")).toBe("other");
	});

	test("missing/unmatched route pattern falls back to other, never throws", () => {
		expect(classifyRouteClass(undefined)).toBe("other");
		expect(classifyRouteClass(null)).toBe("other");
		expect(classifyRouteClass("/*")).toBe("other");
	});

	test("never returns a value outside the closed class set", () => {
		for (const route of ["/api/stacks/:org/foo/bar", "/some/random/path", ""]) {
			expect(ROUTE_CLASSES).toContain(classifyRouteClass(route));
		}
	});
});

describe("classifyResult", () => {
	const RESULTS: readonly CompatResult[] = [
		"success",
		"protocol-error",
		"client-error",
		"auth-error",
		"unsupported-version",
		"server-error",
	];

	test("2xx/3xx statuses are success", () => {
		expect(classifyResult(200)).toBe("success");
		expect(classifyResult(204)).toBe("success");
		expect(classifyResult(304)).toBe("success");
	});

	test("401/403 are auth-error", () => {
		expect(classifyResult(401)).toBe("auth-error");
		expect(classifyResult(403)).toBe("auth-error");
	});

	test("415 is unsupported-version", () => {
		expect(classifyResult(415)).toBe("unsupported-version");
	});

	test("protocol validation and conflict statuses are protocol-error", () => {
		expect(classifyResult(400)).toBe("protocol-error");
		expect(classifyResult(409)).toBe("protocol-error");
	});

	test("other 4xx statuses are client-error", () => {
		expect(classifyResult(404)).toBe("client-error");
		expect(classifyResult(413)).toBe("client-error");
		expect(classifyResult(422)).toBe("client-error");
		expect(classifyResult(429)).toBe("client-error");
	});

	test("5xx statuses are server-error", () => {
		expect(classifyResult(500)).toBe("server-error");
		expect(classifyResult(503)).toBe("server-error");
	});

	test("never returns a value outside the closed result set", () => {
		for (const status of [100, 200, 301, 400, 401, 403, 404, 409, 415, 422, 429, 500, 503]) {
			expect(RESULTS).toContain(classifyResult(status));
		}
	});
});

describe("compatibility request telemetry", () => {
	test("compatibilityRequestCount returns a Counter singleton", () => {
		const c = compatibilityRequestCount();
		expect(c).toBeDefined();
		expect(typeof c.add).toBe("function");
		expect(compatibilityRequestCount()).toBe(c);
	});

	test("recordCompatibilityRequest accepts a full range of inputs without throwing (telemetry-disabled/no-op path)", () => {
		expect(() =>
			recordCompatibilityRequest({
				userAgent: "pulumi-cli/1 (3.9.0; linux)",
				accept: "application/vnd.pulumi+8",
				routePattern: "/api/stacks/:org/:project/:stack/batch-encrypt",
				status: 200,
			}),
		).not.toThrow();
		expect(() =>
			recordCompatibilityRequest({
				userAgent: undefined,
				accept: undefined,
				routePattern: undefined,
				status: 404,
			}),
		).not.toThrow();
		expect(() =>
			recordCompatibilityRequest({
				userAgent: null,
				accept: null,
				routePattern: "/*",
				status: 500,
			}),
		).not.toThrow();
	});
});
