// @procella/updates — Pure helper functions.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { UntypedDeployment } from "@procella/types";
import { BadRequestError, InvalidUpdateTokenError } from "@procella/types";
import type { TextEdit, TextEditSpanPoint } from "./types.js";
import {
	CheckpointSequenceError,
	LEASE_DURATION_SECONDS,
	SUPPORTED_DEPLOYMENT_SCHEMA_VERSION,
} from "./types.js";

// ============================================================================
// Lease Token
// ============================================================================

/** Generate a cryptographically secure lease token for an active update. */
export function generateLeaseToken(updateId: string, stackId: string): string {
	const secret = randomBytes(32).toString("hex");
	return `update:${updateId}:${stackId}:${secret}`;
}

/** Parse a lease token back into its components. */
export function parseLeaseToken(token: string): { updateId: string; stackId: string } {
	const parts = token.split(":");
	if (parts.length !== 4 || parts[0] !== "update" || !parts[1] || !parts[2] || !parts[3]) {
		throw new InvalidUpdateTokenError();
	}
	return { updateId: parts[1], stackId: parts[2] };
}

/** Constant-time comparison of two token strings via SHA-256 digest. */
export function safeTokenCompare(a: string, b: string): boolean {
	const hashA = createHash("sha256").update(a).digest();
	const hashB = createHash("sha256").update(b).digest();
	return timingSafeEqual(hashA, hashB);
}

// ============================================================================
// Blob Storage Keys
// ============================================================================

/** Format the blob storage key for a checkpoint. */
export function formatBlobKey(stackId: string, updateId: string, version: number): string {
	return `checkpoints/${stackId}/${updateId}/${version}`;
}

/**
 * Format the blob storage key for an update's delta baseline text.
 *
 * Keyed by sequence number so a rolled-back transaction can never leave the previously
 * committed baseline row pointing at overwritten bytes.
 */
export function formatDeltaBaseBlobKey(
	stackId: string,
	updateId: string,
	sequenceNumber: number,
): string {
	return `checkpoints/${stackId}/${updateId}/base-${sequenceNumber}`;
}

// ============================================================================
// JSON Merge Patch (RFC 7396)
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply a JSON merge patch (RFC 7396) to a base value.
 *
 * - If delta is not a plain object, it replaces base entirely.
 * - For each key in delta: null deletes, objects recurse, everything else overwrites.
 */
export function applyDelta(base: unknown, delta: unknown): unknown {
	if (!isPlainObject(delta)) {
		return delta;
	}

	const result: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};

	for (const [key, value] of Object.entries(delta)) {
		if (value === null) {
			delete result[key];
		} else if (isPlainObject(value) && isPlainObject(result[key])) {
			result[key] = applyDelta(result[key], value);
		} else {
			result[key] = value;
		}
	}

	return result;
}

// ============================================================================
// Deployment Text Deltas
// ============================================================================

const utf8Encoder = new TextEncoder();
/** Fatal so corrupt bytes surface as an explicit error instead of silent U+FFFD substitution. */
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Lowercase SHA-256 hex digest of deployment text, matching the CLI's `checkpointHash`. */
export function hashDeploymentText(text: string): string {
	return createHash("sha256").update(utf8Encoder.encode(text)).digest("hex");
}

function isTextEditPoint(value: unknown): value is TextEditSpanPoint {
	if (!isPlainObject(value)) return false;
	const { offset } = value;
	return Number.isInteger(offset) && typeof offset === "number" && offset >= 0;
}

/** Validate a raw `deploymentDelta` payload into typed edits. */
export function parseTextEdits(value: unknown): TextEdit[] {
	if (!Array.isArray(value)) {
		throw new BadRequestError("deploymentDelta must be an array of TextEdit");
	}
	return value.map((entry) => {
		if (!isPlainObject(entry)) {
			throw new BadRequestError("deploymentDelta entries must be objects");
		}
		const { span, newText } = entry;
		if (typeof newText !== "string") {
			throw new BadRequestError("TextEdit newText must be a string");
		}
		if (!isPlainObject(span)) {
			throw new BadRequestError("TextEdit span must be an object");
		}
		const { start, end } = span;
		if (!isTextEditPoint(start) || !isTextEditPoint(end)) {
			throw new BadRequestError("TextEdit spans must use non-negative integer offsets");
		}
		return { span: { start, end }, newText } satisfies TextEdit;
	});
}

/**
 * Apply the CLI's textual diff to the exact previous deployment bytes.
 *
 * Offsets are UTF-8 byte offsets into `before` because upstream derives them from a Go
 * `[]byte` buffer; applying them to UTF-16 string indices corrupts any non-ASCII payload.
 */
export function applyTextEdits(before: Uint8Array, edits: TextEdit[]): Uint8Array {
	if (edits.length === 0) {
		return before;
	}

	const sorted = [...edits].sort(
		(a, b) => a.span.start.offset - b.span.start.offset || a.span.end.offset - b.span.end.offset,
	);

	const pieces: Uint8Array[] = [];
	let total = 0;
	let last = 0;

	const push = (chunk: Uint8Array): void => {
		pieces.push(chunk);
		total += chunk.length;
	};

	for (const edit of sorted) {
		const start = edit.span.start.offset;
		const end = edit.span.end.offset;

		if (!Number.isInteger(start) || !Number.isInteger(end)) {
			throw new BadRequestError("TextEdit spans must use integer offsets");
		}

		if (start < 0 || end < 0 || start > end || end > before.length) {
			throw new BadRequestError("TextEdit span is out of bounds");
		}

		if (start < last) {
			throw new BadRequestError("TextEdit spans must not overlap");
		}

		if (start > last) {
			push(before.subarray(last, start));
		}
		push(utf8Encoder.encode(edit.newText));
		last = end;
	}

	if (last < before.length) {
		push(before.subarray(last));
	}

	const result = new Uint8Array(total);
	let offset = 0;
	for (const piece of pieces) {
		result.set(piece, offset);
		offset += piece.length;
	}
	return result;
}

/**
 * Apply a delta to the exact last-saved deployment text and return the resulting text
 * together with its SHA-256 digest.
 *
 * Hashing happens on the produced bytes, before decoding, so the digest is computed over
 * exactly what the CLI hashed. Decoding is fatal, so a delta that produces invalid UTF-8 is
 * a client error rather than a silently mangled baseline.
 */
export function applyDeploymentDelta(
	baseText: string,
	edits: TextEdit[],
): { text: string; hash: string } {
	const bytes = applyTextEdits(utf8Encoder.encode(baseText), edits);
	const hash = createHash("sha256").update(bytes).digest("hex");
	let text: string;
	try {
		text = utf8Decoder.decode(bytes);
	} catch {
		throw new BadRequestError("Applying deploymentDelta produced invalid UTF-8");
	}
	return { text, hash };
}

/** Normalize and require the delta request's `checkpointHash`. */
export function requireCheckpointHash(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
		throw new BadRequestError("checkpointHash must be a 64-character SHA-256 hex digest");
	}
	return value.toLowerCase();
}

/** Require an integer, non-negative checkpoint sequence number. */
export function requireSequenceNumber(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new BadRequestError("sequenceNumber must be a non-negative integer");
	}
	return value;
}

// ============================================================================
// Deployment Envelopes
// ============================================================================

/**
 * Reject deployment envelopes Procella cannot round-trip.
 *
 * Procella advertises `deployment-schema-version` 3, so a compliant CLI downgrades before
 * sending. Anything higher, or any non-empty `features` list, would be accepted and then
 * silently re-exported as v3 with the feature data dropped — so it is refused outright.
 */
export function assertSupportedDeploymentEnvelope(
	envelope: { version?: unknown; features?: unknown },
	context: string,
): void {
	const { version, features } = envelope;

	if (version !== undefined && version !== null) {
		if (typeof version !== "number" || !Number.isInteger(version)) {
			throw new BadRequestError(`${context}: deployment schema version must be an integer`);
		}
		if (version > SUPPORTED_DEPLOYMENT_SCHEMA_VERSION) {
			throw new BadRequestError(
				`${context}: unsupported deployment schema version ${version}; ` +
					`Procella supports up to version ${SUPPORTED_DEPLOYMENT_SCHEMA_VERSION}`,
			);
		}
	}

	if (features !== undefined && features !== null) {
		if (!Array.isArray(features)) {
			throw new BadRequestError(`${context}: deployment features must be an array`);
		}
		if (features.length > 0) {
			throw new BadRequestError(
				`${context}: unsupported deployment features [${features.join(", ")}]; ` +
					`Procella supports up to deployment schema version ${SUPPORTED_DEPLOYMENT_SCHEMA_VERSION}`,
			);
		}
	}
}

/**
 * Parse verbatim/delta deployment text into its inner deployment payload.
 *
 * Upstream always sends an `apitype.UntypedDeployment` envelope. A payload without a
 * `deployment` member is treated as the deployment itself, preserving the tolerance the
 * verbatim endpoint has always had for hand-written clients.
 */
export function parseDeploymentText(text: string, context: string): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new BadRequestError(`${context}: deployment text is not valid JSON`);
	}

	if (isPlainObject(parsed) && "deployment" in parsed) {
		assertSupportedDeploymentEnvelope(parsed, context);
		return parsed.deployment;
	}

	return parsed;
}

// ============================================================================
// Checkpoint Sequencing
// ============================================================================

/** `apply` persists the write; `replay` is a byte-identical retry that must not mutate state. */
export type CheckpointSequenceDecision = "apply" | "replay";

/**
 * Enforce `sequenceNumber` as an idempotency and ordering key.
 *
 * Upstream increments the counter once per accepted save and reuses the same value when it
 * falls back from a rejected delta to a full verbatim upload, so an equal sequence number is
 * legitimate — but only when it carries the content already stored. `isStoredResult` is a
 * callback because proving that requires hashing or comparing a potentially huge payload.
 */
export function classifyCheckpointSequence(args: {
	storedSequenceNumber: number | undefined;
	requestSequenceNumber: number;
	isStoredResult: () => boolean;
}): CheckpointSequenceDecision {
	const { storedSequenceNumber, requestSequenceNumber, isStoredResult } = args;

	if (storedSequenceNumber === undefined) {
		return "apply";
	}

	if (requestSequenceNumber < storedSequenceNumber) {
		throw new CheckpointSequenceError(
			`Stale checkpoint sequence number ${requestSequenceNumber}; ` +
				`sequence ${storedSequenceNumber} is already stored`,
		);
	}

	if (requestSequenceNumber === storedSequenceNumber) {
		if (isStoredResult()) {
			return "replay";
		}
		throw new CheckpointSequenceError(
			`Conflicting content for checkpoint sequence number ${requestSequenceNumber}`,
		);
	}

	if (requestSequenceNumber > storedSequenceNumber + 1) {
		throw new CheckpointSequenceError(
			`Out-of-order checkpoint sequence number ${requestSequenceNumber}; ` +
				`expected ${storedSequenceNumber + 1}`,
		);
	}

	return "apply";
}

// ============================================================================
// Raw JSON Member Extraction
// ============================================================================

function skipJsonWhitespace(source: string, index: number): number {
	let i = index;
	while (i < source.length) {
		const ch = source[i];
		if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") break;
		i++;
	}
	return i;
}

/** Return the index just past the closing quote of the string starting at `start`. */
function scanJsonString(source: string, start: number): number {
	let i = start + 1;
	while (i < source.length) {
		const ch = source[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === '"') return i + 1;
		i++;
	}
	throw new BadRequestError("Malformed JSON body: unterminated string");
}

/** Return the index just past the JSON value starting at `start`. */
function scanJsonValue(source: string, start: number): number {
	const first = source[start];

	if (first === '"') return scanJsonString(source, start);

	if (first === "{" || first === "[") {
		let depth = 0;
		let i = start;
		while (i < source.length) {
			const ch = source[i];
			if (ch === '"') {
				i = scanJsonString(source, i);
				continue;
			}
			if (ch === "{" || ch === "[") depth++;
			else if (ch === "}" || ch === "]") {
				depth--;
				if (depth === 0) return i + 1;
			}
			i++;
		}
		throw new BadRequestError("Malformed JSON body: unterminated object or array");
	}

	let i = start;
	while (i < source.length) {
		const ch = source[i];
		if (
			ch === "," ||
			ch === "}" ||
			ch === "]" ||
			ch === " " ||
			ch === "\t" ||
			ch === "\n" ||
			ch === "\r"
		) {
			break;
		}
		i++;
	}
	if (i === start) throw new BadRequestError("Malformed JSON body: expected a value");
	return i;
}

/**
 * Return the exact source text of a top-level member of a JSON object.
 *
 * `JSON.parse` followed by `JSON.stringify` is not byte-faithful — it reorders nothing but
 * does normalize number formatting and re-escapes strings — so the verbatim checkpoint path
 * must slice the value straight out of the request body. Duplicate keys resolve to the last
 * occurrence, matching `JSON.parse`.
 */
export function extractRawJsonMember(source: string, key: string): string | undefined {
	let i = skipJsonWhitespace(source, 0);
	if (source[i] !== "{") {
		throw new BadRequestError("Malformed JSON body: expected an object");
	}
	i = skipJsonWhitespace(source, i + 1);
	if (source[i] === "}") return undefined;

	let found: string | undefined;
	for (;;) {
		if (source[i] !== '"') {
			throw new BadRequestError("Malformed JSON body: expected a member name");
		}
		const keyEnd = scanJsonString(source, i);
		const rawKey = source.slice(i, keyEnd);
		i = skipJsonWhitespace(source, keyEnd);
		if (source[i] !== ":") {
			throw new BadRequestError("Malformed JSON body: expected ':' after a member name");
		}
		i = skipJsonWhitespace(source, i + 1);
		const valueEnd = scanJsonValue(source, i);
		const memberName: unknown = JSON.parse(rawKey);
		if (memberName === key) {
			found = source.slice(i, valueEnd);
		}
		i = skipJsonWhitespace(source, valueEnd);
		if (source[i] === ",") {
			i = skipJsonWhitespace(source, i + 1);
			continue;
		}
		if (source[i] === "}") return found;
		throw new BadRequestError("Malformed JSON body: expected ',' or '}'");
	}
}

// ============================================================================
// Lease Expiry
// ============================================================================

/** Calculate the lease expiration timestamp. */
export function leaseExpiresAt(durationSeconds: number = LEASE_DURATION_SECONDS): Date {
	return new Date(Date.now() + durationSeconds * 1000);
}

// ============================================================================
// Empty Deployment
// ============================================================================

/** Return a valid empty UntypedDeployment (version 3). */
export function emptyDeployment(): UntypedDeployment {
	return {
		version: 3,
		deployment: {
			manifest: {
				time: new Date().toISOString(),
				magic: "",
				version: "",
			},
			resources: [],
		},
	};
}
