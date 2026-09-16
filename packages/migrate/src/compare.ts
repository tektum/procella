/**
 * Canonical logical deployment-state comparison, shared by `migrateOne`'s post-import
 * verification and standalone `validate()`.
 *
 * Historically each caller ran its own shallow check: `migrateOne` compared resource
 * *counts*, `validate()` compared resource *URN sets*. Both certify a "match" for states
 * that share a count/URN-set but differ in id, inputs, outputs, dependencies, pending
 * operations, or secret values — exactly the corruption this module exists to catch.
 *
 * Field scope is derived from Pulumi's own `apitype.ResourceV3`/`DeploymentV3` shapes
 * (sdk/go/common/apitype/core.go) and the export/import round trip in
 * pkg/resource/stack/deployment.go + pkg/cmd/pulumi/stack/io.go (`SaveSnapshot`). Three,
 * and only three, deployment-level differences are known-legitimate and excluded below:
 *
 *   1. `deployment.secrets_providers` — migration intentionally rebinds this to the
 *      target's own secret provider (see migrate.ts). Comparing it would flag every
 *      correct migration as a mismatch.
 *   2. `deployment.manifest.time` — a "last write" provenance timestamp, not migrated
 *      resource content. `manifest.magic`/`manifest.version`/`manifest.plugins` remain
 *      in scope (magic is a checksum of version; both are real tooling provenance).
 *   3. Empty `deployment.metadata` versus an omitted field — `apitype.DeploymentV3`'s
 *      `Metadata` field is a non-pointer Go struct, so `encoding/json` emits `{}` even
 *      when the source predates metadata. Metadata content, including unknown/future
 *      fields, remains in scope.
 *
 * Everything else — every resource field, `pending_operations`, and any unrecognised
 * deployment-level key — is compared verbatim so unknown/future fields are never
 * silently dropped. Notably `pending_operations` is NOT normalized away: Pulumi's own
 * `stack import` unconditionally discards pending operations (`SaveSnapshot` sets
 * `snapshot.PendingOperations = nil` before uploading, io.go), so a source stack with an
 * unresolved pending operation will legitimately fail this comparison after migration —
 * that is a real, previously-silent data-loss bug this module now surfaces instead of
 * hiding.
 *
 * Secrets are compared by *decrypted logical value*, never by ciphertext (which is
 * expected to differ — target re-encrypts under its own provider) and never by
 * assuming an undecryptable value matches (that would let corrupted/unverifiable
 * secrets pass silently). Decrypted values and raw ciphertext never appear in mismatch
 * `detail` strings.
 */
import type { UntypedDeployment } from "./types.js";

// Pulumi's `resource.sig.Key`/`resource.sig.Secret` (sdk/go/common/resource/sig/sig.go).
// A secret envelope is `{ [SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE, ciphertext?, plaintext? }`
// with exactly one of `ciphertext`/`plaintext` populated (pkg/resource/stack/deployment.go).
export const SECRET_SIGNATURE_KEY = "4dabf18193072939515e22adb298388d";
export const SECRET_SIGNATURE = "1b47061264138c4ac30d75fd1eb44270";

/** Highest Pulumi deployment schema version this comparator can safely interpret. */
const MAX_COMPARABLE_DEPLOYMENT_SCHEMA_VERSION = 3;

/** DeploymentV3 fields tagged `omitempty` in the pinned Pulumi apitype. */
const DEPLOYMENT_OMITTABLE_FIELDS: Readonly<Record<string, true>> = {
	pending_operations: true,
	metadata: true,
	snippets: true,
	extensions: true,
};

/**
 * ResourceV3 fields whose absent and JSON-zero forms are equivalent after the pinned
 * Pulumi Go decoder/encoder round trip. `custom` is required on output, but an absent
 * input decodes to `false` and is re-emitted as such.
 */
const RESOURCE_OMITTABLE_FIELDS: Readonly<Record<string, true>> = {
	custom: true,
	delete: true,
	id: true,
	inputs: true,
	outputs: true,
	parent: true,
	protect: true,
	taint: true,
	external: true,
	dependencies: true,
	initErrors: true,
	provider: true,
	propertyDependencies: true,
	pendingReplacement: true,
	additionalSecretOutputs: true,
	aliases: true,
	customTimeouts: true,
	importID: true,
	retainOnDelete: true,
	deletedWith: true,
	replaceWith: true,
	created: true,
	modified: true,
	sourcePosition: true,
	stackTrace: true,
	ignoreChanges: true,
	hideDiff: true,
	replaceOnChanges: true,
	replacementTrigger: true,
	refreshBeforeUpdate: true,
	viewOf: true,
	resourceHooks: true,
	extensionRef: true,
	snippetID: true,
};

export type DeploymentMismatchKind =
	| "unsupported-schema"
	| "missing-on-target"
	| "missing-on-source"
	| "duplicate-urn-count"
	| "field-mismatch"
	| "unverifiable-secret";

export interface DeploymentMismatch {
	/** Resource URN this mismatch concerns, if any (absent for deployment-level fields). */
	urn?: string;
	kind: DeploymentMismatchKind;
	/** JSON-pointer-ish path to the differing field, e.g. "outputs.password" or "dependencies[1]". */
	path: string;
	/** Safe for logs and errors: never includes a secret plaintext or ciphertext value. */
	detail: string;
}

export interface DeploymentComparisonResult {
	match: boolean;
	/** True when at least one mismatch could not be conclusively verified (never counted as a match). */
	unverifiable: boolean;
	mismatches: DeploymentMismatch[];
	sourceResourceCount: number;
	targetResourceCount: number;
}

/**
 * Decrypts a batch of ciphertexts scoped to one deployment's own secret provider.
 * Returns a map from the exact ciphertext string to its decrypted logical value
 * (the JSON-encoded property value, matching Pulumi's own `plaintext` envelope
 * encoding). Ciphertexts that cannot be decrypted are simply absent from the result —
 * the comparator treats a missing entry as unverifiable rather than throwing, so one
 * bad secret never aborts the whole comparison.
 */
export type BatchSecretDecrypter = (ciphertexts: string[]) => Promise<Map<string, string>>;

export interface CompareDeploymentsOptions {
	/** Decrypts ciphertext secrets embedded in `source`. Omit if source is plaintext-only. */
	decryptSource?: BatchSecretDecrypter;
	/** Decrypts ciphertext secrets embedded in `target`. Omit if target is plaintext-only. */
	decryptTarget?: BatchSecretDecrypter;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretEnvelope(value: unknown): value is Record<string, unknown> {
	return isPlainObject(value) && value[SECRET_SIGNATURE_KEY] === SECRET_SIGNATURE;
}

// Unforgeable markers for this module's own internal wrapper values. Symbol keys can never
// appear in JSON.parse output, so no value parsed from deployment content (however it is
// shaped, e.g. `{__resolvedSecret: true, value: "x", extra: "y"}`) can impersonate a sentinel
// and smuggle an unexamined sibling field (like `extra` above) past the comparison below.
const RESOLVED_SECRET = Symbol("resolvedSecret");
const UNVERIFIABLE_SECRET = Symbol("unverifiableSecret");

/** Sentinel wrapping a resolved (decrypted or already-plaintext) secret's logical value. */
interface ResolvedSecret {
	[RESOLVED_SECRET]: true;
	value: unknown;
}

/** Sentinel marking a secret this comparator could not conclusively verify. */
interface UnverifiableSecret {
	[UNVERIFIABLE_SECRET]: true;
}

function isResolvedSecret(value: unknown): value is ResolvedSecret {
	return isPlainObject(value) && Reflect.get(value, RESOLVED_SECRET) === true;
}

function isUnverifiableSecret(value: unknown): value is UnverifiableSecret {
	return isPlainObject(value) && Reflect.get(value, UNVERIFIABLE_SECRET) === true;
}

/** Parse a Pulumi secret's JSON-encoded logical value, falling back to the raw string. */
function parseLogicalValue(encoded: string): unknown {
	try {
		return JSON.parse(encoded);
	} catch {
		return encoded;
	}
}

/** Collect every distinct ciphertext string found anywhere in `value`. */
function collectCiphertexts(value: unknown, into: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectCiphertexts(item, into);
		return;
	}
	if (!isPlainObject(value)) return;
	if (isSecretEnvelope(value)) {
		if (typeof value.ciphertext === "string") into.add(value.ciphertext);
		// Plaintext envelopes need no decryption; nested envelopes inside a plaintext's
		// logical value (unusual, but not disallowed) are still worth scanning.
		if (typeof value.plaintext === "string") {
			collectCiphertexts(parseLogicalValue(value.plaintext), into);
		}
		return;
	}
	for (const key of Object.keys(value)) collectCiphertexts(value[key], into);
}

/**
 * Replace every secret envelope in `value` with a `ResolvedSecret`/`UnverifiableSecret`
 * sentinel carrying its decrypted logical value. Pure/synchronous — decryption results
 * are pre-fetched into `decrypted` by the caller so this pass never needs to be async.
 */
function resolveSecrets(value: unknown, decrypted: ReadonlyMap<string, string>): unknown {
	if (Array.isArray(value)) return value.map((item) => resolveSecrets(item, decrypted));
	if (!isPlainObject(value)) return value;

	if (isSecretEnvelope(value)) {
		if (typeof value.plaintext === "string") {
			const resolved: ResolvedSecret = {
				[RESOLVED_SECRET]: true,
				value: resolveSecrets(parseLogicalValue(value.plaintext), decrypted),
			};
			return resolved;
		}
		if (typeof value.ciphertext === "string") {
			const plaintext = decrypted.get(value.ciphertext);
			if (plaintext === undefined) {
				const unverifiable: UnverifiableSecret = { [UNVERIFIABLE_SECRET]: true };
				return unverifiable;
			}
			const resolved: ResolvedSecret = {
				[RESOLVED_SECRET]: true,
				value: resolveSecrets(parseLogicalValue(plaintext), decrypted),
			};
			return resolved;
		}
		// Envelope carries neither `ciphertext` nor `plaintext` — malformed; cannot verify.
		const unverifiable: UnverifiableSecret = { [UNVERIFIABLE_SECRET]: true };
		return unverifiable;
	}

	// `Object.create(null)`, not `{}`: an own key literally named `__proto__` in parsed
	// deployment or decrypted secret JSON would otherwise set this object's prototype
	// instead of becoming a comparable data key, letting two different `__proto__` values
	// both collapse to the same empty-looking object.
	const out: Record<string, unknown> = Object.create(null);
	for (const key of Object.keys(value)) out[key] = resolveSecrets(value[key], decrypted);
	return out;
}

async function resolveSide(
	value: unknown,
	decrypter: BatchSecretDecrypter | undefined,
): Promise<unknown> {
	const ciphertexts = new Set<string>();
	collectCiphertexts(value, ciphertexts);
	let decrypted = new Map<string, string>();
	if (ciphertexts.size > 0 && decrypter) {
		try {
			decrypted = await decrypter([...ciphertexts]);
		} catch {
			// Leave `decrypted` empty — every ciphertext resolves to unverifiable below.
		}
	}
	return resolveSecrets(value, decrypted);
}

const MAX_SCALAR_DESCRIPTION_LENGTH = 120;

function describeScalar(value: unknown): string {
	if (value === undefined) return "undefined";
	let encoded: string;
	try {
		encoded = JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
	return encoded.length > MAX_SCALAR_DESCRIPTION_LENGTH
		? `${encoded.slice(0, MAX_SCALAR_DESCRIPTION_LENGTH)}…`
		: encoded;
}

/**
 * True for a JSON "zero value" (`undefined`, `null`, `""`, `false`, `0`, `[]`, `{}`).
 * Pulumi's wire-format structs (`apitype.ResourceV3`/`DeploymentV3`) tag nearly every
 * optional field `,omitempty`; Go's `encoding/json` elides the key entirely for any of
 * these zero values. A hand-built or differently-populated deployment that spells one of
 * these out explicitly is not materially different from one where the real pulumi
 * export/import round trip dropped the key — only genuinely non-empty content differs.
 */
function isEmptyJsonValue(value: unknown): boolean {
	// A secret sentinel is never a wire-format zero value — its Symbol-keyed brand is
	// invisible to `Object.keys`, so without this check an `UnverifiableSecret` wrapper
	// (zero string keys) or a single-field `ResolvedSecret` wrapper would otherwise look
	// "empty" here and be silently dropped as if the field were merely omitted, letting an
	// undecryptable secret present on only one side pass without a mismatch.
	if (isResolvedSecret(value) || isUnverifiableSecret(value)) return false;
	if (value === undefined || value === null || value === false || value === "" || value === 0) {
		return true;
	}
	if (Array.isArray(value)) return value.length === 0;
	if (isPlainObject(value)) return Object.keys(value).length === 0;
	return false;
}

/**
 * Structural diff of two already secret-resolved values. `sensitiveRootPath`, once set,
 * marks that the walk has descended into a resolved secret's logical value — mismatches
 * found there are reported at that fixed root path with no descendant path or key names,
 * per the "never log secret material" requirement (a decrypted structured secret's own
 * field names, e.g. `{"private-token": ...}`, are still material to keep out of logs).
 * `sensitiveRootPath` is captured once, on entry into a resolved secret, and held fixed
 * for every deeper recursive call — it never reflects the descendant path being compared.
 *
 * `omittableFields` applies the `omitempty`-vs-explicit-empty equivalence (see
 * `isEmptyJsonValue`) only to direct keys proven to carry that tag in the pinned Pulumi
 * wire type. It is never propagated to recursive calls, so unknown/future fields and
 * opaque user content remain material.
 */
function diffValues(
	path: string,
	a: unknown,
	b: unknown,
	sensitiveRootPath: string | undefined,
	urn: string | undefined,
	out: DeploymentMismatch[],
	omittableFields?: Readonly<Record<string, true>>,
): void {
	const reportPath = sensitiveRootPath ?? path;

	if (isUnverifiableSecret(a) || isUnverifiableSecret(b)) {
		out.push({
			urn,
			kind: "unverifiable-secret",
			path: reportPath,
			detail: `secret value at ${reportPath || "<root>"} could not be verified (decryption unavailable or failed)`,
		});
		return;
	}

	if (isResolvedSecret(a) && isResolvedSecret(b)) {
		diffValues(path, a.value, b.value, sensitiveRootPath ?? path, urn, out);
		return;
	}
	if (isResolvedSecret(a) || isResolvedSecret(b)) {
		out.push({
			urn,
			kind: "field-mismatch",
			path: reportPath,
			detail: `${reportPath || "<root>"}: one side is a secret and the other is not`,
		});
		return;
	}

	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) {
			out.push({
				urn,
				kind: "field-mismatch",
				path: reportPath,
				detail:
					sensitiveRootPath !== undefined
						? `${reportPath}: secret array length differs (redacted)`
						: `${path}: array length differs (source=${a.length}, target=${b.length})`,
			});
			return;
		}
		for (let i = 0; i < a.length; i++) {
			diffValues(`${path}[${i}]`, a[i], b[i], sensitiveRootPath, urn, out);
		}
		return;
	}
	if (Array.isArray(a) !== Array.isArray(b)) {
		out.push({
			urn,
			kind: "field-mismatch",
			path: reportPath,
			detail:
				sensitiveRootPath !== undefined
					? `${reportPath}: secret value differs in shape (redacted)`
					: `${path || "<root>"}: type differs (array vs non-array)`,
		});
		return;
	}

	if (isPlainObject(a) && isPlainObject(b)) {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		for (const key of keys) {
			const childPath = path ? `${path}.${key}` : key;
			const hasA = Object.hasOwn(a, key);
			const hasB = Object.hasOwn(b, key);
			if (hasA && hasB) {
				diffValues(childPath, a[key], b[key], sensitiveRootPath, urn, out);
			} else if (
				omittableFields !== undefined &&
				Object.hasOwn(omittableFields, key) &&
				isEmptyJsonValue(hasA ? a[key] : b[key])
			) {
				// The pinned wire type omits this field when it contains a JSON zero value.
			} else {
				out.push({
					urn,
					kind: "field-mismatch",
					path: sensitiveRootPath ?? childPath,
					detail:
						sensitiveRootPath !== undefined
							? `${reportPath}: secret value differs (redacted)`
							: `${childPath}: present on ${hasA ? "source" : "target"} only`,
				});
			}
		}
		return;
	}
	if (isPlainObject(a) !== isPlainObject(b)) {
		out.push({
			urn,
			kind: "field-mismatch",
			path: reportPath,
			detail:
				sensitiveRootPath !== undefined
					? `${reportPath}: secret value differs in shape (redacted)`
					: `${path || "<root>"}: type differs (object vs scalar)`,
		});
		return;
	}

	if (!Object.is(a, b)) {
		out.push({
			urn,
			kind: "field-mismatch",
			path: reportPath,
			detail:
				sensitiveRootPath !== undefined
					? `${reportPath || "<root>"}: secret value differs (redacted)`
					: `${path || "<root>"}: expected ${describeScalar(a)}, got ${describeScalar(b)}`,
		});
	}
}

/**
 * Stable sort key so duplicate-URN groups (pending-delete remnants) pair up deterministically.
 * Secret sentinels (see `resolveSecrets`) carry a symbol-keyed brand invisible to
 * `Object.keys`, so a resolved secret `{value: "x"}` would otherwise produce the exact same
 * signature as an ordinary field `{value: "x"}` — recognise them explicitly so a secret
 * slot can never be paired against a non-secret slot (or an unverifiable one) by signature.
 */
function canonicalSignature(value: unknown): string {
	if (isUnverifiableSecret(value)) return "\u0000unverifiable-secret\u0000";
	if (isResolvedSecret(value))
		return `\u0000resolved-secret\u0000${canonicalSignature(value.value)}`;
	if (Array.isArray(value)) return `[${value.map(canonicalSignature).join(",")}]`;
	if (isPlainObject(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalSignature(value[k])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * Strip known `ResourceV3` `omitempty` fields whose value is a JSON zero value before
 * computing a duplicate-URN pairing signature. Unknown fields remain material.
 */
function normalizeResourceForSignature(value: unknown): unknown {
	if (!isPlainObject(value)) return value;
	const out: Record<string, unknown> = Object.create(null);
	for (const key of Object.keys(value)) {
		if (Object.hasOwn(RESOURCE_OMITTABLE_FIELDS, key) && isEmptyJsonValue(value[key])) continue;
		out[key] = value[key];
	}
	return out;
}

function groupByUrn(resources: unknown[]): Map<string, unknown[]> {
	const groups = new Map<string, unknown[]>();
	for (const resource of resources) {
		const urn = isPlainObject(resource) && typeof resource.urn === "string" ? resource.urn : "";
		const group = groups.get(urn) ?? [];
		group.push(resource);
		groups.set(urn, group);
	}
	return groups;
}

function compareResources(
	sourceResources: unknown,
	targetResources: unknown,
	out: DeploymentMismatch[],
): void {
	const sourceList = Array.isArray(sourceResources) ? sourceResources : [];
	const targetList = Array.isArray(targetResources) ? targetResources : [];
	const sourceGroups = groupByUrn(sourceList);
	const targetGroups = groupByUrn(targetList);
	const urns = new Set([...sourceGroups.keys(), ...targetGroups.keys()]);

	for (const urn of urns) {
		const sourceGroup = sourceGroups.get(urn) ?? [];
		const targetGroup = targetGroups.get(urn) ?? [];

		if (sourceGroup.length === 0) {
			out.push({
				urn,
				kind: "missing-on-source",
				path: "",
				detail: `resource ${urn} is present on target but missing on source`,
			});
			continue;
		}
		if (targetGroup.length === 0) {
			out.push({
				urn,
				kind: "missing-on-target",
				path: "",
				detail: `resource ${urn} is present on source but missing on target`,
			});
			continue;
		}
		if (sourceGroup.length !== targetGroup.length) {
			out.push({
				urn,
				kind: "duplicate-urn-count",
				path: "",
				detail: `resource ${urn} appears ${sourceGroup.length}x on source but ${targetGroup.length}x on target`,
			});
			continue;
		}

		// Sort by (normalized, raw) signature, not array position: two entries whose
		// normalized signatures tie (e.g. `marker: false` vs `marker: null`, both stripped
		// by normalizeResourceForSignature) still order consistently on both sides because
		// the raw signature differs — pairing no longer depends on which side happened to
		// declare them in which order.
		const pairingKey = (resource: unknown): string =>
			`${canonicalSignature(normalizeResourceForSignature(resource))}\u0000${canonicalSignature(resource)}`;
		const sortedSource = [...sourceGroup].sort((a, b) =>
			pairingKey(a).localeCompare(pairingKey(b)),
		);
		const sortedTarget = [...targetGroup].sort((a, b) =>
			pairingKey(a).localeCompare(pairingKey(b)),
		);
		for (let i = 0; i < sortedSource.length; i++) {
			diffValues(
				"",
				sortedSource[i],
				sortedTarget[i],
				undefined,
				urn,
				out,
				RESOURCE_OMITTABLE_FIELDS,
			);
		}
	}
}

function schemaVersionMismatch(
	label: "source" | "target",
	version: unknown,
): DeploymentMismatch | undefined {
	if (version === undefined || version === null) return undefined;
	if (typeof version !== "number" || !Number.isInteger(version)) {
		return {
			kind: "unsupported-schema",
			path: "version",
			detail: `${label} deployment schema version is not an integer`,
		};
	}
	if (version > MAX_COMPARABLE_DEPLOYMENT_SCHEMA_VERSION) {
		return {
			kind: "unsupported-schema",
			path: "version",
			detail: `${label} deployment schema version ${version} exceeds the highest version this comparator can verify (${MAX_COMPARABLE_DEPLOYMENT_SCHEMA_VERSION})`,
		};
	}
	return undefined;
}

/**
 * Compare two Pulumi deployments for logical equality: same resources (by URN),
 * identical material fields (id, type, inputs, outputs, dependencies, parent, provider,
 * pending operations, and any other field pulumi/procella may carry), and identical
 * decrypted secret values. See module doc for the two deployment-level exclusions.
 */
export async function compareDeploymentState(
	source: UntypedDeployment,
	target: UntypedDeployment,
	opts: CompareDeploymentsOptions = {},
): Promise<DeploymentComparisonResult> {
	const sourceResourceCount = Array.isArray(source.deployment?.resources)
		? source.deployment.resources.length
		: 0;
	const targetResourceCount = Array.isArray(target.deployment?.resources)
		? target.deployment.resources.length
		: 0;

	const mismatches: DeploymentMismatch[] = [];

	const sourceVersionIssue = schemaVersionMismatch("source", source.version);
	const targetVersionIssue = schemaVersionMismatch("target", target.version);
	if (sourceVersionIssue) mismatches.push(sourceVersionIssue);
	if (targetVersionIssue) mismatches.push(targetVersionIssue);
	if (sourceVersionIssue || targetVersionIssue) {
		// Cannot safely interpret resource/property semantics beyond this point.
		return {
			match: false,
			unverifiable: true,
			mismatches,
			sourceResourceCount,
			targetResourceCount,
		};
	}

	const [resolvedSource, resolvedTarget] = await Promise.all([
		resolveSide(source.deployment, opts.decryptSource),
		resolveSide(target.deployment, opts.decryptTarget),
	]);

	const sourceDeployment = isPlainObject(resolvedSource) ? resolvedSource : {};
	const targetDeployment = isPlainObject(resolvedTarget) ? resolvedTarget : {};

	// Deployment-level fields, excluding the documented legitimate differences.
	const sourceFields: Record<string, unknown> = { ...sourceDeployment };
	const targetFields: Record<string, unknown> = { ...targetDeployment };
	sourceFields.secrets_providers = undefined;
	targetFields.secrets_providers = undefined;
	sourceFields.resources = undefined;
	targetFields.resources = undefined;

	if (isPlainObject(sourceFields.manifest)) {
		sourceFields.manifest = { ...sourceFields.manifest, time: undefined };
	}
	if (isPlainObject(targetFields.manifest)) {
		targetFields.manifest = { ...targetFields.manifest, time: undefined };
	}
	// Metadata content is material. The deployment-level omitempty rule below only treats
	// an absent metadata field and `metadata: {}` as equivalent; unknown nested fields are
	// compared recursively and can no longer disappear unnoticed.

	diffValues(
		"",
		sourceFields,
		targetFields,
		undefined,
		undefined,
		mismatches,
		DEPLOYMENT_OMITTABLE_FIELDS,
	);

	compareResources(sourceDeployment.resources, targetDeployment.resources, mismatches);

	const unverifiable = mismatches.some(
		(m) => m.kind === "unverifiable-secret" || m.kind === "unsupported-schema",
	);

	return {
		match: mismatches.length === 0,
		unverifiable,
		mismatches,
		sourceResourceCount,
		targetResourceCount,
	};
}

/** Format the first mismatch (and a count of any others) for a precise, actionable error. */
export function describeFirstMismatch(result: DeploymentComparisonResult): string {
	const [first, ...rest] = result.mismatches;
	if (!first) return "deployments match";
	const scope = first.urn ? `resource ${first.urn}` : "deployment";
	const suffix = rest.length > 0 ? ` (and ${rest.length} more mismatch(es))` : "";
	return `${scope}: ${first.detail}${suffix}`;
}
