import { describe, expect, test } from "bun:test";
import {
	BadRequestError,
	type Caller,
	InvalidUpdateTokenError,
	JournalEntryBegin,
	JournalEntryFailure,
	JournalEntryOutputs,
	JournalEntryRebuiltBaseState,
	JournalEntryRefreshSuccess,
	JournalEntrySecretsManager,
	JournalEntrySuccess,
	JournalEntryWrite,
	UpdateConflictError,
} from "@procella/types";
import {
	applyDelta,
	applyDeploymentDelta,
	applyTextEdits,
	assertSupportedDeploymentEnvelope,
	classifyCheckpointSequence,
	emptyDeployment,
	extractRawJsonMember,
	formatBlobKey,
	formatDeltaBaseBlobKey,
	generateLeaseToken,
	hashDeploymentText,
	leaseExpiresAt,
	parseDeploymentText,
	parseLeaseToken,
	parseTextEdits,
	requireCheckpointHash,
	requireSequenceNumber,
	safeTokenCompare,
} from "./helpers.js";
import {
	applyJournalEntries,
	deriveGitHubUpdateTarget,
	detectEventKind,
	type JournalRow,
	journalEntryValues,
	mapStatusToApiStatus,
	PostgresUpdatesService,
} from "./postgres.js";
import type { UpdatesService } from "./types.js";
import {
	BLOB_THRESHOLD,
	CheckpointSequenceError,
	GC_ADVISORY_LOCK_ID,
	GC_INTERVAL_MS,
	GC_STALE_THRESHOLD_MS,
	LEASE_DURATION_SECONDS,
	type TextEdit,
} from "./types.js";

describe("@procella/updates helpers", () => {
	// ========================================================================
	// generateLeaseToken
	// ========================================================================

	describe("generateLeaseToken", () => {
		test("returns 4-part format with random secret", () => {
			const token = generateLeaseToken("update-1", "stack-1");
			const parts = token.split(":");
			expect(parts).toHaveLength(4);
			expect(parts[0]).toBe("update");
			expect(parts[1]).toBe("update-1");
			expect(parts[2]).toBe("stack-1");
			expect(parts[3]).toHaveLength(64);
		});

		test("generates unique tokens for same inputs", () => {
			const token1 = generateLeaseToken("update-1", "stack-1");
			const token2 = generateLeaseToken("update-1", "stack-1");
			expect(token1).not.toBe(token2);
		});
	});

	// ========================================================================
	// parseLeaseToken
	// ========================================================================

	describe("parseLeaseToken", () => {
		test("roundtrips with generateLeaseToken", () => {
			const token = generateLeaseToken("abc-123", "stack-xyz");
			const parsed = parseLeaseToken(token);
			expect(parsed.updateId).toBe("abc-123");
			expect(parsed.stackId).toBe("stack-xyz");
		});

		test("throws InvalidUpdateTokenError on too few parts (3-part old format)", () => {
			expect(() => parseLeaseToken("update:abc:def")).toThrow(InvalidUpdateTokenError);
		});

		test("throws InvalidUpdateTokenError on too few parts", () => {
			expect(() => parseLeaseToken("update:only-one")).toThrow(InvalidUpdateTokenError);
		});

		test("throws InvalidUpdateTokenError on wrong prefix", () => {
			expect(() => parseLeaseToken("token:abc:def:secret")).toThrow(InvalidUpdateTokenError);
		});

		test("throws InvalidUpdateTokenError on empty segments", () => {
			expect(() => parseLeaseToken("update::stack-1:secret")).toThrow(InvalidUpdateTokenError);
			expect(() => parseLeaseToken("update:abc::secret")).toThrow(InvalidUpdateTokenError);
			expect(() => parseLeaseToken("update:abc:stack:")).toThrow(InvalidUpdateTokenError);
		});
	});

	// ========================================================================
	// safeTokenCompare
	// ========================================================================

	describe("safeTokenCompare", () => {
		test("returns true for identical tokens", () => {
			const token = generateLeaseToken("update-1", "stack-1");
			expect(safeTokenCompare(token, token)).toBe(true);
		});

		test("returns false for different content", () => {
			const a = generateLeaseToken("update-1", "stack-1");
			const b = generateLeaseToken("update-1", "stack-1");
			expect(safeTokenCompare(a, b)).toBe(false);
		});

		test("returns false for different lengths", () => {
			expect(safeTokenCompare("short", "a-much-longer-token-string")).toBe(false);
		});

		test("returns true for identical plain strings", () => {
			expect(safeTokenCompare("abc123", "abc123")).toBe(true);
		});
	});

	// ========================================================================
	// formatBlobKey
	// ========================================================================

	describe("formatBlobKey", () => {
		test("returns correct path", () => {
			const key = formatBlobKey("stack-1", "update-1", 5);
			expect(key).toBe("checkpoints/stack-1/update-1/5");
		});
	});

	// ========================================================================
	// applyDelta (RFC 7396 JSON Merge Patch)
	// ========================================================================

	describe("applyDelta", () => {
		test("adds new key to object", () => {
			const result = applyDelta({ a: 1 }, { b: 2 });
			expect(result).toEqual({ a: 1, b: 2 });
		});

		test("overwrites existing key", () => {
			const result = applyDelta({ a: 1 }, { a: 99 });
			expect(result).toEqual({ a: 99 });
		});

		test("deletes key with null value", () => {
			const result = applyDelta({ a: 1, b: 2 }, { b: null });
			expect(result).toEqual({ a: 1 });
		});

		test("merges nested objects", () => {
			const base = { nested: { x: 1, y: 2 } };
			const delta = { nested: { y: 99, z: 3 } };
			expect(applyDelta(base, delta)).toEqual({ nested: { x: 1, y: 99, z: 3 } });
		});

		test("non-object delta replaces entirely", () => {
			expect(applyDelta({ a: 1 }, "hello")).toBe("hello");
			expect(applyDelta({ a: 1 }, 42)).toBe(42);
			expect(applyDelta({ a: 1 }, null)).toBeNull();
		});

		test("array in delta replaces (not merges)", () => {
			const result = applyDelta({ items: [1, 2, 3] }, { items: [4, 5] });
			expect(result).toEqual({ items: [4, 5] });
		});

		test("handles non-object base with object delta", () => {
			const result = applyDelta("string-base", { a: 1 });
			expect(result).toEqual({ a: 1 });
		});
	});

	describe("applyTextEdits (gotextdiff)", () => {
		// applyTextEdits works on UTF-8 bytes (Go byte offsets); these cases are ASCII, so a
		// decode wrapper keeps them readable.
		const applyToText = (before: string, edits: TextEdit[]): string =>
			new TextDecoder().decode(applyTextEdits(new TextEncoder().encode(before), edits));

		test("resolves offsets as UTF-8 byte offsets, not UTF-16 code units", () => {
			// "é" is 2 UTF-8 bytes but 1 JS string index; a UTF-16-based implementation would
			// splice one byte early and corrupt the payload.
			const before = new TextEncoder().encode('{"a":"é","b":1}');
			const edits: TextEdit[] = [
				{
					span: {
						start: { line: 1, column: 0, offset: 14 },
						end: { line: 1, column: 0, offset: 15 },
					},
					newText: "2",
				},
			];
			expect(new TextDecoder().decode(applyTextEdits(before, edits))).toBe('{"a":"é","b":2}');
			// In UTF-16 the digit sits at index 13, so a string-index implementation writes over ':'.
			expect('{"a":"é","b":1}'.indexOf("1")).toBe(13);
		});

		test("returns original when edits array is empty", () => {
			const before = '{"resources":[]}';
			expect(applyToText(before, [])).toBe(before);
		});

		test("replaces a substring at given offsets", () => {
			const before = '{"resources":[]}';
			const edits = [
				{
					span: {
						start: { line: 0, column: 0, offset: 14 },
						end: { line: 0, column: 0, offset: 14 },
						uri: "",
					},
					newText: '{"urn":"test"}',
				},
			];
			expect(applyToText(before, edits)).toBe('{"resources":[{"urn":"test"}]}');
		});

		test("inserts text (start === end)", () => {
			const before = "abc";
			const edits = [
				{
					span: {
						start: { line: 0, column: 0, offset: 1 },
						end: { line: 0, column: 0, offset: 1 },
					},
					newText: "X",
				},
			];
			expect(applyToText(before, edits)).toBe("aXbc");
		});

		test("deletes text (newText is empty)", () => {
			const before = "abcdef";
			const edits = [
				{
					span: {
						start: { line: 0, column: 0, offset: 2 },
						end: { line: 0, column: 0, offset: 4 },
					},
					newText: "",
				},
			];
			expect(applyToText(before, edits)).toBe("abef");
		});

		test("applies multiple non-overlapping edits in order", () => {
			const before = "abcdef";
			const edits = [
				{
					span: {
						start: { line: 0, column: 0, offset: 1 },
						end: { line: 0, column: 0, offset: 2 },
					},
					newText: "X",
				},
				{
					span: {
						start: { line: 0, column: 0, offset: 4 },
						end: { line: 0, column: 0, offset: 5 },
					},
					newText: "Y",
				},
			];
			expect(applyToText(before, edits)).toBe("aXcdYf");
		});

		test("rejects negative spans", () => {
			const before = "abcdef";
			const edits = [
				{
					span: {
						start: { line: 0, column: 0, offset: -1 },
						end: { line: 0, column: 0, offset: 1 },
					},
					newText: "X",
				},
			];

			expect(() => applyToText(before, edits)).toThrow(BadRequestError);
		});

		test("rejects out-of-bounds spans", () => {
			const before = "abcdef";
			const edits = [
				{
					span: {
						start: { line: 0, column: 0, offset: 2 },
						end: { line: 0, column: 0, offset: 99 },
					},
					newText: "X",
				},
			];

			expect(() => applyToText(before, edits)).toThrow(BadRequestError);
		});

		test("rejects overlapping spans after sorting", () => {
			const before = "abcdef";
			const edits = [
				{
					span: {
						start: { line: 0, column: 0, offset: 3 },
						end: { line: 0, column: 0, offset: 5 },
					},
					newText: "Y",
				},
				{
					span: {
						start: { line: 0, column: 0, offset: 1 },
						end: { line: 0, column: 0, offset: 4 },
					},
					newText: "X",
				},
			];

			expect(() => applyToText(before, edits)).toThrow(BadRequestError);
		});

		test("handles edit at start of string (offset 0)", () => {
			const before = "world";
			const edits = [
				{
					span: {
						start: { line: 0, column: 0, offset: 0 },
						end: { line: 0, column: 0, offset: 0 },
					},
					newText: "hello ",
				},
			];
			expect(applyToText(before, edits)).toBe("hello world");
		});

		test("handles edit at end of string", () => {
			const before = "hello";
			const edits = [
				{
					span: {
						start: { line: 0, column: 0, offset: 5 },
						end: { line: 0, column: 0, offset: 5 },
					},
					newText: " world",
				},
			];
			expect(applyToText(before, edits)).toBe("hello world");
		});

		test("handles full string replacement", () => {
			const before = "abc";
			const edits = [
				{
					span: {
						start: { line: 0, column: 0, offset: 0 },
						end: { line: 0, column: 0, offset: 3 },
					},
					newText: "xyz",
				},
			];
			expect(applyToText(before, edits)).toBe("xyz");
		});

		test("sorts edits by start offset regardless of input order", () => {
			const before = "abcdef";
			const edits = [
				{
					span: {
						start: { line: 0, column: 0, offset: 4 },
						end: { line: 0, column: 0, offset: 5 },
					},
					newText: "Y",
				},
				{
					span: {
						start: { line: 0, column: 0, offset: 1 },
						end: { line: 0, column: 0, offset: 2 },
					},
					newText: "X",
				},
			];
			expect(applyToText(before, edits)).toBe("aXcdYf");
		});
	});

	// ========================================================================
	// Delta checkpoint integrity
	// ========================================================================

	describe("extractRawJsonMember", () => {
		test("returns the exact source text, preserving key order and number formatting", () => {
			// JSON.parse + JSON.stringify would emit {"version":3,...,"n":1e+30} and reorder
			// nothing but renormalize the number, breaking every later delta.
			const body =
				'{"version":3,"untypedDeployment":{"version":3,"deployment":{"z":1,"a":1.0,"n":1e30}},"sequenceNumber":1}';
			const raw = extractRawJsonMember(body, "untypedDeployment");
			expect(raw).toBe('{"version":3,"deployment":{"z":1,"a":1.0,"n":1e30}}');
			expect(raw).not.toBe(JSON.stringify(JSON.parse(raw as string)));
		});

		test("preserves escaped characters byte-for-byte", () => {
			const body = '{"untypedDeployment":{"s":"a\\u0041\\"b\\\\c\\/d"},"sequenceNumber":1}';
			expect(extractRawJsonMember(body, "untypedDeployment")).toBe('{"s":"a\\u0041\\"b\\\\c\\/d"}');
		});

		test("tolerates whitespace and finds members in any position", () => {
			const body = '{\n  "sequenceNumber" : 4 ,\n  "untypedDeployment" : [1, 2]\n}';
			expect(extractRawJsonMember(body, "untypedDeployment")).toBe("[1, 2]");
			expect(extractRawJsonMember(body, "sequenceNumber")).toBe("4");
		});

		test("is not confused by braces or quotes inside strings", () => {
			const body = '{"a":"}{\\"","untypedDeployment":{"k":"v"}}';
			expect(extractRawJsonMember(body, "untypedDeployment")).toBe('{"k":"v"}');
		});

		test("returns undefined for an absent member", () => {
			expect(extractRawJsonMember('{"version":3}', "untypedDeployment")).toBeUndefined();
			expect(extractRawJsonMember("{}", "untypedDeployment")).toBeUndefined();
		});

		test("resolves duplicate keys to the last occurrence, matching JSON.parse", () => {
			const body = '{"untypedDeployment":1,"untypedDeployment":2}';
			expect(extractRawJsonMember(body, "untypedDeployment")).toBe("2");
		});
	});

	describe("applyDeploymentDelta", () => {
		test("returns the applied text and the digest the CLI computes over it", () => {
			const base = '{"version":3,"deployment":{"resources":[]}}';
			const next = '{"version":3,"deployment":{"resources":[1]}}';
			const edits: TextEdit[] = [
				{
					span: {
						start: { line: 1, column: 0, offset: base.indexOf("[]") + 1 },
						end: { line: 1, column: 0, offset: base.indexOf("[]") + 1 },
					},
					newText: "1",
				},
			];
			const applied = applyDeploymentDelta(base, edits);
			expect(applied.text).toBe(next);
			expect(applied.hash).toBe(hashDeploymentText(next));
		});

		test("preserves multi-byte content and hashes the produced bytes", () => {
			const base = '{"deployment":{"note":"héllo","n":1}}';
			const digitOffset = new TextEncoder().encode(base).lastIndexOf(0x31);
			const edits: TextEdit[] = [
				{
					span: {
						start: { line: 1, column: 0, offset: digitOffset },
						end: { line: 1, column: 0, offset: digitOffset + 1 },
					},
					newText: "2",
				},
			];
			const applied = applyDeploymentDelta(base, edits);
			expect(applied.text).toBe('{"deployment":{"note":"héllo","n":2}}');
			expect(applied.hash).toBe(hashDeploymentText(applied.text));
		});
	});

	describe("hashDeploymentText", () => {
		test("matches Go's hex.EncodeToString(sha256.Sum256(...))", () => {
			// echo -n "" | sha256sum
			expect(hashDeploymentText("")).toBe(
				"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			);
		});
	});

	describe("requireCheckpointHash", () => {
		test("requires a 64-character hex digest and normalizes case", () => {
			const upper = "A".repeat(64);
			expect(requireCheckpointHash(upper)).toBe("a".repeat(64));
			expect(() => requireCheckpointHash("")).toThrow(BadRequestError);
			expect(() => requireCheckpointHash(undefined)).toThrow(BadRequestError);
			expect(() => requireCheckpointHash("abc")).toThrow(BadRequestError);
			expect(() => requireCheckpointHash("z".repeat(64))).toThrow(BadRequestError);
		});
	});

	describe("requireSequenceNumber", () => {
		test("requires a non-negative integer", () => {
			expect(requireSequenceNumber(0)).toBe(0);
			expect(requireSequenceNumber(7)).toBe(7);
			expect(() => requireSequenceNumber(-1)).toThrow(BadRequestError);
			expect(() => requireSequenceNumber(1.5)).toThrow(BadRequestError);
			expect(() => requireSequenceNumber("1")).toThrow(BadRequestError);
		});
	});

	describe("parseTextEdits", () => {
		test("accepts well-formed edits", () => {
			const parsed = parseTextEdits([
				{ span: { start: { offset: 0 }, end: { offset: 1 } }, newText: "x" },
			]);
			expect(parsed[0].span.start.offset).toBe(0);
			expect(parsed[0].newText).toBe("x");
		});

		test("rejects malformed payloads", () => {
			expect(() => parseTextEdits("nope")).toThrow(BadRequestError);
			expect(() => parseTextEdits([1])).toThrow(BadRequestError);
			expect(() => parseTextEdits([{ span: {}, newText: "x" }])).toThrow(BadRequestError);
			expect(() =>
				parseTextEdits([{ span: { start: { offset: -1 }, end: { offset: 0 } }, newText: "x" }]),
			).toThrow(BadRequestError);
			expect(() =>
				parseTextEdits([{ span: { start: { offset: 0 }, end: { offset: 1 } } }]),
			).toThrow(BadRequestError);
		});
	});

	describe("assertSupportedDeploymentEnvelope", () => {
		test("accepts schema v1 through v3 with no features", () => {
			for (const version of [1, 2, 3]) {
				expect(() => assertSupportedDeploymentEnvelope({ version }, "ctx")).not.toThrow();
			}
			expect(() =>
				assertSupportedDeploymentEnvelope({ version: 3, features: [] }, "ctx"),
			).not.toThrow();
			expect(() => assertSupportedDeploymentEnvelope({}, "ctx")).not.toThrow();
		});

		test("rejects schema v4 and non-empty features", () => {
			expect(() => assertSupportedDeploymentEnvelope({ version: 4 }, "ctx")).toThrow(
				BadRequestError,
			);
			expect(() =>
				assertSupportedDeploymentEnvelope({ version: 3, features: ["snippets"] }, "ctx"),
			).toThrow(BadRequestError);
			expect(() => assertSupportedDeploymentEnvelope({ version: "3" }, "ctx")).toThrow(
				BadRequestError,
			);
		});
	});

	describe("parseDeploymentText", () => {
		test("unwraps the UntypedDeployment envelope", () => {
			expect(parseDeploymentText('{"version":3,"deployment":{"resources":[]}}', "ctx")).toEqual({
				resources: [],
			});
		});

		test("treats an envelope-less payload as the deployment itself", () => {
			expect(parseDeploymentText('{"resources":[]}', "ctx")).toEqual({ resources: [] });
		});

		test("rejects unsupported envelopes and invalid JSON", () => {
			expect(() => parseDeploymentText('{"version":4,"deployment":{}}', "ctx")).toThrow(
				BadRequestError,
			);
			expect(() =>
				parseDeploymentText('{"version":3,"features":["x"],"deployment":{}}', "ctx"),
			).toThrow(BadRequestError);
			expect(() => parseDeploymentText("{oops", "ctx")).toThrow(BadRequestError);
		});
	});

	describe("classifyCheckpointSequence", () => {
		test("applies the first write for any sequence number", () => {
			expect(
				classifyCheckpointSequence({
					storedSequenceNumber: undefined,
					requestSequenceNumber: 1,
					isStoredResult: () => false,
				}),
			).toBe("apply");
		});

		test("applies the next sequence number", () => {
			expect(
				classifyCheckpointSequence({
					storedSequenceNumber: 2,
					requestSequenceNumber: 3,
					isStoredResult: () => false,
				}),
			).toBe("apply");
		});

		test("treats an identical retry of the stored sequence as a replay", () => {
			let probed = false;
			expect(
				classifyCheckpointSequence({
					storedSequenceNumber: 2,
					requestSequenceNumber: 2,
					isStoredResult: () => {
						probed = true;
						return true;
					},
				}),
			).toBe("replay");
			expect(probed).toBe(true);
		});

		test("rejects different content at an already-used sequence number", () => {
			expect(() =>
				classifyCheckpointSequence({
					storedSequenceNumber: 2,
					requestSequenceNumber: 2,
					isStoredResult: () => false,
				}),
			).toThrow(CheckpointSequenceError);
		});

		test("rejects stale and out-of-order sequence numbers", () => {
			expect(() =>
				classifyCheckpointSequence({
					storedSequenceNumber: 5,
					requestSequenceNumber: 4,
					isStoredResult: () => true,
				}),
			).toThrow(CheckpointSequenceError);
			expect(() =>
				classifyCheckpointSequence({
					storedSequenceNumber: 5,
					requestSequenceNumber: 7,
					isStoredResult: () => true,
				}),
			).toThrow(CheckpointSequenceError);
		});

		test("does not hash the stored payload unless the sequence numbers match", () => {
			let probed = false;
			classifyCheckpointSequence({
				storedSequenceNumber: 2,
				requestSequenceNumber: 3,
				isStoredResult: () => {
					probed = true;
					return true;
				},
			});
			expect(probed).toBe(false);
		});
	});

	describe("formatDeltaBaseBlobKey", () => {
		test("keys the baseline by sequence number so rollback cannot clobber it", () => {
			expect(formatDeltaBaseBlobKey("stack-1", "update-1", 4)).toBe(
				"checkpoints/stack-1/update-1/base-4",
			);
			expect(formatDeltaBaseBlobKey("stack-1", "update-1", 4)).not.toBe(
				formatBlobKey("stack-1", "update-1", 4),
			);
		});
	});

	// ========================================================================
	// leaseExpiresAt
	// ========================================================================

	describe("leaseExpiresAt", () => {
		test("returns future date", () => {
			const now = Date.now();
			const expiry = leaseExpiresAt();
			expect(expiry.getTime()).toBeGreaterThan(now);
		});

		test("uses custom duration", () => {
			const now = Date.now();
			const expiry = leaseExpiresAt(60);
			// Should be ~60 seconds in the future (allow 1s tolerance)
			expect(expiry.getTime()).toBeGreaterThanOrEqual(now + 59_000);
			expect(expiry.getTime()).toBeLessThanOrEqual(now + 61_000);
		});
	});

	// ========================================================================
	// emptyDeployment
	// ========================================================================

	describe("emptyDeployment", () => {
		test("returns version 3", () => {
			const d = emptyDeployment();
			expect(d.version).toBe(3);
		});

		test("has deployment with manifest and resources", () => {
			const d = emptyDeployment();
			const deployment = d.deployment as {
				manifest: { time: string; magic: string; version: string };
				resources: unknown[];
			};
			expect(deployment).toBeDefined();
			expect(deployment.manifest).toBeDefined();
			expect(deployment.manifest.time).toBeTypeOf("string");
			expect(deployment.manifest.magic).toBe("");
			expect(deployment.manifest.version).toBe("");
			expect(deployment.resources).toEqual([]);
		});
	});

	// ========================================================================
	// Constants
	// ========================================================================

	describe("constants", () => {
		test("BLOB_THRESHOLD is 1 MB", () => {
			expect(BLOB_THRESHOLD).toBe(1_048_576);
		});

		test("LEASE_DURATION_SECONDS is 300", () => {
			expect(LEASE_DURATION_SECONDS).toBe(300);
		});

		test("GC_INTERVAL_MS is 60 seconds", () => {
			expect(GC_INTERVAL_MS).toBe(60_000);
		});

		test("GC_STALE_THRESHOLD_MS is 1 hour", () => {
			expect(GC_STALE_THRESHOLD_MS).toBe(3_600_000);
		});

		test("GC_ADVISORY_LOCK_ID is a bigint", () => {
			expect(typeof GC_ADVISORY_LOCK_ID).toBe("bigint");
		});
	});

	// ========================================================================
	// UpdatesService interface (compile-time type satisfaction check)
	// ========================================================================

	describe("UpdatesService interface", () => {
		test("can be satisfied by a mock object", () => {
			const noop = () => Promise.resolve({} as never);
			const mock: UpdatesService = {
				createUpdate: noop,
				startUpdate: noop,
				completeUpdate: noop,
				cancelUpdate: noop,
				patchCheckpoint: noop,
				patchCheckpointVerbatim: noop,
				patchCheckpointDelta: noop,
				appendJournalEntries: noop,
				postEvents: noop,
				renewLease: noop,
				getUpdate: noop,
				getUpdateEvents: noop,
				getHistory: noop,
				exportStack: noop,
				importStack: noop,
				encryptValue: noop,
				decryptValue: noop,
				batchEncrypt: noop,
				batchDecrypt: noop,
				verifyLeaseToken: noop,
				verifyUpdateOwnership: noop,
			};
			expect(Object.keys(mock)).toHaveLength(21);
		});
	});

	// ========================================================================
	// mapStatusToApiStatus
	// ========================================================================

	describe("mapStatusToApiStatus", () => {
		test("maps all DB statuses correctly", () => {
			expect(mapStatusToApiStatus("not started")).toBe("not-started");
			expect(mapStatusToApiStatus("requested")).toBe("not-started");
			expect(mapStatusToApiStatus("running")).toBe("in-progress");
			expect(mapStatusToApiStatus("succeeded")).toBe("succeeded");
			expect(mapStatusToApiStatus("failed")).toBe("failed");
			expect(mapStatusToApiStatus("cancelled")).toBe("cancelled");
		});

		test("returns unknown status as-is", () => {
			expect(mapStatusToApiStatus("something-else")).toBe("something-else");
		});
	});

	// ========================================================================
	// detectEventKind
	// ========================================================================

	describe("detectEventKind", () => {
		test("identifies each event type", () => {
			expect(detectEventKind({ cancelEvent: {} } as never)).toBe("cancel");
			expect(detectEventKind({ stdoutEvent: {} } as never)).toBe("stdout");
			expect(detectEventKind({ diagnosticEvent: {} } as never)).toBe("diagnostic");
			expect(detectEventKind({ preludeEvent: {} } as never)).toBe("prelude");
			expect(detectEventKind({ summaryEvent: {} } as never)).toBe("summary");
			expect(detectEventKind({ resourcePreEvent: {} } as never)).toBe("resource-pre");
			expect(detectEventKind({ resOutputsEvent: {} } as never)).toBe("res-outputs");
			expect(detectEventKind({ resOpFailedEvent: {} } as never)).toBe("res-op-failed");
			expect(detectEventKind({ policyEvent: {} } as never)).toBe("policy");
			expect(detectEventKind({ errorEvent: {} } as never)).toBe("error");
			expect(detectEventKind({ progressEvent: {} } as never)).toBe("progress");
		});

		test("returns 'unknown' for empty event", () => {
			expect(detectEventKind({} as never)).toBe("unknown");
		});
	});

	// ========================================================================
	// pgErrorCode (via PostgresUpdatesService.createUpdate)
	// The pgErrorCode helper is internal; we test it through observable behavior:
	// a 23505 unique-constraint violation on idx_updates_active must surface as
	// UpdateConflictError (not a raw DB error).
	// ========================================================================

	describe("createUpdate — conflict detection (pgErrorCode)", () => {
		function makeDb(
			insertResult: () => Promise<{ id: string }[]>,
			onValues?: (values: Record<string, unknown>) => void,
		) {
			const chainable = {
				from: () => chainable,
				where: () => Promise.resolve([]),
				values: (values: Record<string, unknown>) => {
					onValues?.(values);
					return chainable;
				},
				returning: insertResult,
				set: () => chainable,
			};
			let db: object;
			db = {
				select: () => chainable,
				insert: () => chainable,
				update: () => chainable,
				execute: () => Promise.resolve([{ activeUpdateId: null }]),
				transaction: (callback: (tx: object) => unknown) => callback(db),
			};
			return db as never;
		}

		const noopStorage = {} as never;
		const noopCrypto = {} as never;

		test("resolves with updateID when insert succeeds", async () => {
			const db = makeDb(() => Promise.resolve([{ id: "upd-1" }]));
			const svc = new PostgresUpdatesService({ db, storage: noopStorage, crypto: noopCrypto });
			const result = await svc.createUpdate("stack-1", "update");
			expect(result.updateID).toBe("upd-1");
		});

		test("throws UpdateConflictError on 23505 unique-constraint violation (direct code)", async () => {
			const conflict = Object.assign(new Error("duplicate key"), { code: "23505" });
			const db = makeDb(() => Promise.reject(conflict));
			const svc = new PostgresUpdatesService({ db, storage: noopStorage, crypto: noopCrypto });
			return expect(svc.createUpdate("stack-1", "update")).rejects.toBeInstanceOf(
				UpdateConflictError,
			);
		});

		test("UpdateConflictError message mentions pulumi cancel", async () => {
			const conflict = Object.assign(new Error("duplicate key"), { code: "23505" });
			const db = makeDb(() => Promise.reject(conflict));
			const svc = new PostgresUpdatesService({ db, storage: noopStorage, crypto: noopCrypto });
			return expect(svc.createUpdate("stack-1", "update")).rejects.toMatchObject({
				message: expect.stringContaining("pulumi cancel"),
			});
		});

		test("throws UpdateConflictError when 23505 is nested in cause chain", async () => {
			const inner = Object.assign(new Error("unique violation"), { code: "23505" });
			const outer = Object.assign(new Error("query failed"), { cause: inner });
			const db = makeDb(() => Promise.reject(outer));
			const svc = new PostgresUpdatesService({ db, storage: noopStorage, crypto: noopCrypto });
			return expect(svc.createUpdate("stack-1", "update")).rejects.toBeInstanceOf(
				UpdateConflictError,
			);
		});

		test("throws UpdateConflictError when 23505 is in errno (Bun.sql driver shape)", async () => {
			const bunSqlErr = Object.assign(new Error("ERR_POSTGRES_SERVER_ERROR"), {
				code: "ERR_POSTGRES_SERVER_ERROR",
				errno: "23505",
			});
			const db = makeDb(() => Promise.reject(bunSqlErr));
			const svc = new PostgresUpdatesService({ db, storage: noopStorage, crypto: noopCrypto });
			return expect(svc.createUpdate("stack-1", "update")).rejects.toBeInstanceOf(
				UpdateConflictError,
			);
		});

		test("ignores non-SQLSTATE strings in code field (e.g. ERR_POSTGRES_SERVER_ERROR)", async () => {
			const bunSqlErr = Object.assign(new Error("server error"), {
				code: "ERR_POSTGRES_SERVER_ERROR",
			});
			const db = makeDb(() => Promise.reject(bunSqlErr));
			const svc = new PostgresUpdatesService({ db, storage: noopStorage, crypto: noopCrypto });
			return expect(svc.createUpdate("stack-1", "update")).rejects.toThrow("server error");
		});

		test("re-throws non-conflict DB errors unchanged", async () => {
			const dbErr = Object.assign(new Error("connection reset"), { code: "08006" });
			const db = makeDb(() => Promise.reject(dbErr));
			const svc = new PostgresUpdatesService({ db, storage: noopStorage, crypto: noopCrypto });
			return expect(svc.createUpdate("stack-1", "update")).rejects.toThrow("connection reset");
		});

		test("re-throws errors with no code unchanged", async () => {
			const db = makeDb(() => Promise.reject(new Error("unexpected")));
			const svc = new PostgresUpdatesService({ db, storage: noopStorage, crypto: noopCrypto });
			return expect(svc.createUpdate("stack-1", "update")).rejects.toThrow("unexpected");
		});

		test("first non-preview update starts at version 1", async () => {
			let capturedVersion = 0;
			const db = makeDb(
				() => Promise.resolve([{ id: "upd-2" }]),
				(values) => {
					capturedVersion = values.version as number;
				},
			);
			const svc = new PostgresUpdatesService({ db, storage: noopStorage, crypto: noopCrypto });
			await svc.createUpdate("stack-1", "update");
			expect(capturedVersion).toBe(1);
		});

		test("persists update environment metadata", async () => {
			let capturedEnvironment: Record<string, string> | undefined;
			const db = makeDb(
				() => Promise.resolve([{ id: "upd-metadata" }]),
				(values) => {
					capturedEnvironment = values.environment as Record<string, string>;
				},
			);
			const svc = new PostgresUpdatesService({ db, storage: noopStorage, crypto: noopCrypto });
			const environment = {
				"vcs.owner": "octocat",
				"vcs.repo": "hello-world",
				"ci.pr.number": "42",
				"ci.pr.headSHA": "abc123",
			};

			await svc.createUpdate("stack-1", "preview", undefined, undefined, undefined, environment);

			expect(capturedEnvironment).toEqual(environment);
		});
	});

	describe("deriveGitHubUpdateTarget", () => {
		const caller: Caller = {
			tenantId: "tenant-1",
			orgSlug: "acme",
			userId: "user-1",
			login: "octocat",
			roles: [],
			principalType: "user",
		};
		const stack = {
			tenantId: "tenant-1",
			project: "infra",
			stack: "dev",
			tags: { "vcs:owner": "octocat", "vcs:repo": "hello-world" },
		};
		const environment = {
			"vcs.owner": "octocat",
			"vcs.repo": "hello-world",
			"ci.pr.number": "42",
			"ci.pr.headSHA": "abc123",
		};

		test("returns immutable coordinates from matching update metadata", () => {
			expect(deriveGitHubUpdateTarget({ caller, environment, stack })).toEqual({
				tenantId: "tenant-1",
				owner: "octocat",
				repo: "hello-world",
				prNumber: 42,
				sha: "abc123",
				org: "acme",
				project: "infra",
				stack: "dev",
			});
		});

		test("rejects metadata for a different stack repository", () => {
			expect(
				deriveGitHubUpdateTarget({
					caller,
					environment: { ...environment, "vcs.repo": "other" },
					stack,
				}),
			).toBeNull();
		});

		test("rejects a workload bound to another repository", () => {
			expect(
				deriveGitHubUpdateTarget({
					caller: {
						...caller,
						principalType: "workload",
						workload: {
							provider: "github",
							issuer: "https://token.actions.githubusercontent.com",
							subject: "repo:attacker/other:ref:refs/heads/main",
							repository: "attacker/other",
						},
					},
					environment,
					stack,
				}),
			).toBeNull();
		});

		test("ignores github stack tags as publication authority", () => {
			expect(
				deriveGitHubUpdateTarget({
					caller,
					environment: {
						"vcs.owner": "attacker",
						"vcs.repo": "other",
						"ci.pr.number": "99",
						"ci.pr.headSHA": "bad",
					},
					stack: {
						...stack,
						tags: {
							...stack.tags,
							"github:owner": "attacker",
							"github:repo": "other",
							"github:pr": "99",
							"github:sha": "bad",
						},
					},
				}),
			).toBeNull();
		});
	});

	describe("journalEntryValues", () => {
		test("maps every replay field to its database representation", () => {
			const state = { urn: "urn:a", custom: true, type: "test:index:Resource" };
			const operation = { resource: state, type: "creating" as const };
			const secretsProvider = { type: "passphrase", state: { salt: "salt" } };
			const newSnapshot = {
				manifest: { time: "2026-01-01T00:00:00Z", magic: "abc", version: "3.225.0" },
				resources: [state],
			};

			expect(
				journalEntryValues("update-1", "stack-1", {
					version: 1,
					kind: JournalEntrySuccess,
					sequenceID: 11,
					operationID: 7,
					state,
					operation,
					secretsProvider,
					newSnapshot,
					removeOld: 1,
					removeNew: 2,
					pendingReplacementOld: 3,
					pendingReplacementNew: 4,
					deleteOld: 5,
					deleteNew: 6,
					isRefresh: true,
					elideWrite: true,
				}),
			).toEqual({
				updateId: "update-1",
				stackId: "stack-1",
				sequenceId: 11n,
				operationId: 7n,
				kind: JournalEntrySuccess,
				state,
				operation,
				secretsProvider,
				newSnapshot,
				operationType: null,
				removeOld: 1n,
				removeNew: 2n,
				pendingReplacementOld: 3n,
				pendingReplacementNew: 4n,
				deleteOld: 5n,
				deleteNew: 6n,
				isRefresh: true,
				elideWrite: true,
			});
		});

		test("rejects malformed journal identifiers", () => {
			expect(() =>
				journalEntryValues("update-1", "stack-1", {
					version: 1,
					kind: "success" as never,
					sequenceID: 1,
					operationID: 1,
				}),
			).toThrow(BadRequestError);
		});
	});

	describe("appendJournalEntries", () => {
		test("inserts and flushes a journal batch in one transaction", async () => {
			let transactions = 0;
			let insertedRows: unknown;
			const selectChain = {
				from: () => selectChain,
				where: () => selectChain,
				orderBy: () => Promise.resolve([]),
			};
			const insertChain = {
				values: (rows: unknown) => {
					insertedRows = rows;
					return insertChain;
				},
				onConflictDoNothing: () => Promise.resolve(),
			};
			const tx = {
				execute: () =>
					Promise.resolve([
						{
							stackId: "stack-1",
							status: "running",
							leaseToken: "lease",
							leaseExpiresAt: new Date(Date.now() + 60_000),
						},
					]),
				insert: () => insertChain,
				select: () => selectChain,
			};
			const db = {
				transaction: async (callback: (transaction: typeof tx) => Promise<void>) => {
					transactions++;
					await callback(tx);
				},
			} as never;
			const service = new PostgresUpdatesService({ db, storage: {} as never, crypto: {} as never });

			await service.appendJournalEntries("update-1", {
				entries: [
					{
						version: 1,
						kind: JournalEntryBegin,
						operationID: 1,
						sequenceID: 1,
					},
				],
			});

			expect(transactions).toBe(1);
			expect(insertedRows).toEqual([
				expect.objectContaining({ updateId: "update-1", stackId: "stack-1", sequenceId: 1n }),
			]);
		});
	});

	describe("applyJournalEntries", () => {
		const makeResource = (urn: string, id = "id-1") => ({
			urn,
			custom: true,
			id,
			type: "test:index:Resource",
		});

		const makeEntry = (
			overrides: Partial<JournalRow> & { kind: number; operationId: number },
		): JournalRow => ({
			state: null,
			operation: null,
			secretsProvider: null,
			newSnapshot: null,
			operationType: null,
			removeOld: null,
			removeNew: null,
			pendingReplacementOld: null,
			pendingReplacementNew: null,
			deleteOld: null,
			deleteNew: null,
			isRefresh: false,
			elideWrite: false,
			...overrides,
		});

		const makeBase = (resources: unknown[] = []) => ({
			manifest: { time: "2026-01-01T00:00:00Z", magic: "abc", version: "3.225.0" },
			secrets_providers: { type: "passphrase", state: { salt: "v1:abc" } },
			resources,
			pending_operations: [],
		});

		test("empty entries returns base state unchanged", () => {
			const base = makeBase([makeResource("urn:a")]);
			const result = applyJournalEntries(base, []);
			expect((result.resources as unknown[]).length).toBe(1);
		});

		test("preserves manifest and secrets_providers", () => {
			const base = makeBase([makeResource("urn:a")]);
			const result = applyJournalEntries(base, []);
			expect(result.manifest).toEqual(base.manifest);
			expect(result.secrets_providers).toEqual(base.secrets_providers);
		});

		test("Write entry replaces base deployment entirely", () => {
			const base = makeBase();
			const snapshot = {
				manifest: { time: "new", magic: "new", version: "3.227.0" },
				secrets_providers: { type: "passphrase", state: { salt: "v1:real-salt" } },
				resources: [makeResource("urn:existing")],
				pending_operations: [],
			};
			const entries = [
				makeEntry({ kind: JournalEntryWrite, operationId: 0, newSnapshot: snapshot }),
			];
			const result = applyJournalEntries(base, entries);
			expect((result.secrets_providers as { state: { salt: string } }).state.salt).toBe(
				"v1:real-salt",
			);
			expect((result.resources as unknown[]).length).toBe(1);
		});

		test("SecretsManager entry updates secrets_providers", () => {
			const base = makeBase();
			const entries = [
				makeEntry({
					kind: JournalEntrySecretsManager,
					operationId: 0,
					secretsProvider: { type: "passphrase", state: { salt: "v1:new-salt" } },
				}),
			];
			const result = applyJournalEntries(base, entries);
			expect((result.secrets_providers as { state: { salt: string } }).state.salt).toBe(
				"v1:new-salt",
			);
		});

		test("Begin + Success creates a new resource", () => {
			const base = makeBase();
			const resource = makeResource("urn:a");
			const entries = [
				makeEntry({ kind: JournalEntryBegin, operationId: 1 }),
				makeEntry({ kind: JournalEntrySuccess, operationId: 1, state: resource }),
			];
			const result = applyJournalEntries(base, entries);
			expect((result.resources as unknown[]).length).toBe(1);
		});

		test("Success with removeOld replaces base resource by index", () => {
			const existing = makeResource("urn:a", "id-orig");
			const updated = makeResource("urn:a", "id-updated");
			const base = makeBase([existing]);
			const entries = [
				makeEntry({ kind: JournalEntryBegin, operationId: 1 }),
				makeEntry({ kind: JournalEntrySuccess, operationId: 1, removeOld: 0n, state: updated }),
			];
			const result = applyJournalEntries(base, entries);
			const resources = result.resources as Array<{ id: string }>;
			expect(resources.length).toBe(1);
			expect(resources[0].id).toBe("id-updated");
		});

		test("Success with removeOld and no state deletes base resource", () => {
			const existing = makeResource("urn:a");
			const base = makeBase([existing]);
			const entries = [
				makeEntry({ kind: JournalEntryBegin, operationId: 1 }),
				makeEntry({ kind: JournalEntrySuccess, operationId: 1, removeOld: 0n }),
			];
			const result = applyJournalEntries(base, entries);
			expect((result.resources as unknown[]).length).toBe(0);
		});

		test("Failure entry clears incomplete op without side effects", () => {
			const base = makeBase();
			const entries = [
				makeEntry({ kind: JournalEntryBegin, operationId: 1 }),
				makeEntry({ kind: JournalEntryFailure, operationId: 1 }),
			];
			const result = applyJournalEntries(base, entries);
			expect((result.resources as unknown[]).length).toBe(0);
		});

		test("multiple parallel creates reconstruct correctly", () => {
			const base = makeBase();
			const resA = makeResource("urn:a", "id-a");
			const resB = makeResource("urn:b", "id-b");
			const entries = [
				makeEntry({ kind: JournalEntryBegin, operationId: 1 }),
				makeEntry({ kind: JournalEntryBegin, operationId: 2 }),
				makeEntry({ kind: JournalEntrySuccess, operationId: 1, state: resA }),
				makeEntry({ kind: JournalEntrySuccess, operationId: 2, state: resB }),
			];
			const result = applyJournalEntries(base, entries);
			expect((result.resources as unknown[]).length).toBe(2);
		});

		test("removeNew removes the resource created by the referenced operation", () => {
			const resA = makeResource("urn:a", "id-a");
			const resB = makeResource("urn:b", "id-b");
			const entries = [
				makeEntry({ kind: JournalEntrySuccess, operationId: 1, state: resA }),
				makeEntry({ kind: JournalEntrySuccess, operationId: 2, removeNew: 1n, state: resB }),
			];

			const result = applyJournalEntries(makeBase(), entries);
			expect((result.resources as Array<{ urn: string }>).map((resource) => resource.urn)).toEqual([
				resB.urn,
			]);
		});

		test("orders newly-created dependencies before an updated dependent", () => {
			const dnsRecord = makeResource("urn:dns", "dns-id");
			const certificate = {
				...makeResource("urn:certificate", "certificate-id"),
				dependencies: [dnsRecord.urn],
			};
			const domain = {
				...makeResource("urn:domain", "domain-id"),
				dependencies: [certificate.urn],
			};
			const base = makeBase([makeResource(domain.urn, "old-domain-id")]);
			const entries = [
				makeEntry({ kind: JournalEntryBegin, operationId: 1 }),
				makeEntry({ kind: JournalEntrySuccess, operationId: 1, state: dnsRecord }),
				makeEntry({ kind: JournalEntryBegin, operationId: 2 }),
				makeEntry({ kind: JournalEntrySuccess, operationId: 2, state: certificate }),
				makeEntry({ kind: JournalEntryBegin, operationId: 3 }),
				makeEntry({ kind: JournalEntrySuccess, operationId: 3, removeOld: 0n, state: domain }),
			];

			const result = applyJournalEntries(base, entries);
			expect((result.resources as Array<{ urn: string }>).map((resource) => resource.urn)).toEqual([
				dnsRecord.urn,
				certificate.urn,
				domain.urn,
			]);
		});

		test("Outputs replaces a newly-created resource by operation ID without moving it", () => {
			const initial = makeResource("urn:a", "initial-id");
			const updated = makeResource("urn:a", "updated-id");
			const entries = [
				makeEntry({ kind: JournalEntrySuccess, operationId: 1, state: initial }),
				makeEntry({ kind: JournalEntryOutputs, operationId: 2, removeNew: 1n, state: updated }),
			];

			const result = applyJournalEntries(makeBase(), entries);
			expect(result.resources).toEqual([updated]);
		});

		test("preserves deletion and pending-replacement markers", () => {
			const deletedBase = makeResource("urn:deleted-base", "deleted-base-id");
			const pendingBase = makeResource("urn:pending-base", "pending-base-id");
			const newResource = makeResource("urn:new", "new-id");
			const entries = [
				makeEntry({ kind: JournalEntrySuccess, operationId: 1, state: newResource }),
				makeEntry({
					kind: JournalEntrySuccess,
					operationId: 2,
					deleteOld: 0n,
					deleteNew: 1n,
					pendingReplacementOld: 1n,
					pendingReplacementNew: 1n,
				}),
			];

			const result = applyJournalEntries(makeBase([deletedBase, pendingBase]), entries);
			expect(result.resources).toEqual([
				{ ...newResource, delete: true, pendingReplacement: true },
				{ ...deletedBase, delete: true },
				{ ...pendingBase, pendingReplacement: true },
			]);
		});

		test("tracks incomplete operations until success or failure", () => {
			const operation = { resource: makeResource("urn:a"), type: "creating" };
			const pending = applyJournalEntries(makeBase(), [
				makeEntry({ kind: JournalEntryBegin, operationId: 1, operation }),
			]);
			expect(pending.pending_operations).toEqual([operation]);

			const completed = applyJournalEntries(makeBase(), [
				makeEntry({ kind: JournalEntryBegin, operationId: 1, operation }),
				makeEntry({ kind: JournalEntryFailure, operationId: 1 }),
			]);
			expect(completed.pending_operations).toEqual([]);
		});

		test("refresh deletion prunes dangling dependency metadata and clears a removed parent", () => {
			const root = makeResource("urn:root", "root-id");
			const removed = { ...makeResource("urn:removed", "removed-id"), parent: root.urn };
			const dependent = {
				...makeResource("urn:dependent", "dependent-id"),
				parent: removed.urn,
				dependencies: [root.urn, removed.urn],
				property_dependencies: { input: [root.urn, removed.urn] },
				replaceWith: [root.urn, removed.urn],
				deletedWith: removed.urn,
			};
			const entries = [
				makeEntry({ kind: JournalEntryRefreshSuccess, operationId: 1, removeOld: 1n }),
			];

			const result = applyJournalEntries(makeBase([root, removed, dependent]), entries);
			const resources = result.resources as Array<Record<string, unknown>>;
			expect(resources.map((resource) => resource.urn)).toEqual([root.urn, dependent.urn]);
			expect(resources[1]).toMatchObject({
				parent: undefined,
				dependencies: [root.urn],
				property_dependencies: { input: [root.urn] },
				replaceWith: [root.urn],
			});
			expect("deletedWith" in resources[1]).toBe(false);
		});

		test("refresh replay does not mutate the cached base deployment", () => {
			const removed = makeResource("urn:removed", "removed-id");
			const dependent = {
				...makeResource("urn:dependent", "dependent-id"),
				dependencies: [removed.urn],
			};
			const base = makeBase([removed, dependent]);
			const original = structuredClone(base);

			applyJournalEntries(base, [
				makeEntry({ kind: JournalEntryRefreshSuccess, operationId: 1, removeOld: 0n }),
			]);

			expect(base).toEqual(original);
		});

		test("refresh preserves a parent retained later in the rebuilt snapshot", () => {
			const parent = makeResource("urn:parent", "parent-id");
			const child = { ...makeResource("urn:child", "child-id"), parent: parent.urn };
			const entries = [
				makeEntry({
					kind: JournalEntrySuccess,
					operationId: 1,
					state: child,
					isRefresh: true,
				}),
			];

			const result = applyJournalEntries(makeBase([parent]), entries);
			expect(result.resources).toEqual([child, parent]);
		});

		test("retains only creating operations from the base snapshot", () => {
			const creating = { resource: makeResource("urn:create"), type: "creating" };
			const deleting = { resource: makeResource("urn:delete"), type: "deleting" };
			const base = { ...makeBase(), pending_operations: [creating, deleting] };

			const result = applyJournalEntries(base, []);
			expect(result.pending_operations).toEqual([creating]);
		});

		test("persisted refresh success also prunes dangling dependencies", () => {
			const removed = makeResource("urn:removed", "removed-id");
			const dependent = {
				...makeResource("urn:dependent", "dependent-id"),
				dependencies: [removed.urn],
			};
			const entries = [
				makeEntry({
					kind: JournalEntrySuccess,
					operationId: 1,
					removeOld: 0n,
					isRefresh: true,
				}),
			];

			const result = applyJournalEntries(makeBase([removed, dependent]), entries);
			expect(result.resources).toEqual([{ ...dependent, dependencies: [] }]);
		});

		test("RebuiltBaseState rebases later journal entries", () => {
			const baseResource = makeResource("urn:base", "base-id");
			const first = makeResource("urn:first", "first-id");
			const second = makeResource("urn:second", "second-id");
			const entries = [
				makeEntry({ kind: JournalEntrySuccess, operationId: 1, state: first }),
				makeEntry({ kind: JournalEntryRebuiltBaseState, operationId: 0 }),
				makeEntry({ kind: JournalEntrySuccess, operationId: 2, state: second }),
			];

			const result = applyJournalEntries(makeBase([baseResource]), entries);
			expect((result.resources as Array<{ urn: string }>).map((resource) => resource.urn)).toEqual([
				second.urn,
				first.urn,
				baseResource.urn,
			]);
		});

		test("Write + SecretsManager + Begin/Success: full lifecycle", () => {
			const snapshot = {
				manifest: { time: "t", magic: "m", version: "v" },
				resources: [],
				pending_operations: [],
			};
			const sp = { type: "passphrase", state: { salt: "v1:correct-salt" } };
			const resource = makeResource("urn:a");
			const entries = [
				makeEntry({ kind: JournalEntryWrite, operationId: 0, newSnapshot: snapshot }),
				makeEntry({ kind: JournalEntrySecretsManager, operationId: 0, secretsProvider: sp }),
				makeEntry({ kind: JournalEntryBegin, operationId: 1 }),
				makeEntry({ kind: JournalEntrySuccess, operationId: 1, state: resource }),
			];
			const result = applyJournalEntries({}, entries);
			expect((result.secrets_providers as { state: { salt: string } }).state.salt).toBe(
				"v1:correct-salt",
			);
			expect((result.resources as unknown[]).length).toBe(1);
			expect(result.manifest).toEqual(snapshot.manifest);
		});
	});
});
