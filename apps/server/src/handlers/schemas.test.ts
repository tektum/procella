import { describe, expect, test } from "bun:test";
import {
	BatchDecryptRequestSchema,
	BatchEncryptRequestSchema,
	EncryptValueRequestSchema,
	EngineEventBatchSchema,
	JournalEntriesSchema,
	MAX_BATCH_CRYPT_ITEMS,
	MAX_JSON_DEPTH,
	MAX_STRING_LENGTH,
	PatchUpdateCheckpointDeltaRequestSchema,
	PatchUpdateCheckpointRequestSchema,
	PatchUpdateVerbatimCheckpointRequestSchema,
	RenewUpdateLeaseRequestSchema,
	UntypedDeploymentSchema,
} from "./schemas.js";

function createNestedObject(depth: number): unknown {
	let current: Record<string, unknown> = { leaf: true };
	for (let level = 0; level < depth; level++) {
		current = { child: current };
	}
	return current;
}

describe("Pulumi request schemas", () => {
	test("rejects deeply nested JSON bodies past 32 levels", () => {
		const tooDeep = createNestedObject(MAX_JSON_DEPTH + 1);

		expect(
			PatchUpdateCheckpointRequestSchema.safeParse({
				version: 3,
				deployment: tooDeep,
			}).success,
		).toBe(false);

		expect(
			PatchUpdateVerbatimCheckpointRequestSchema.safeParse({
				version: 3,
				sequenceNumber: 1,
				untypedDeployment: tooDeep,
			}).success,
		).toBe(false);

		expect(
			PatchUpdateCheckpointDeltaRequestSchema.safeParse({
				version: 1,
				checkpointHash: "hash",
				sequenceNumber: 1,
				deploymentDelta: [tooDeep],
			}).success,
		).toBe(false);

		expect(
			UntypedDeploymentSchema.safeParse({
				version: 3,
				deployment: tooDeep,
			}).success,
		).toBe(false);

		expect(
			EngineEventBatchSchema.safeParse({
				events: [tooDeep],
			}).success,
		).toBe(false);

		expect(
			JournalEntriesSchema.safeParse({
				entries: [
					{
						version: 1,
						kind: 1,
						operationID: 1,
						sequenceID: 1,
						state: tooDeep,
					},
				],
			}).success,
		).toBe(false);
	});

	test("rejects events batches over 1000 entries", () => {
		const result = EngineEventBatchSchema.safeParse({
			events: Array.from({ length: 1001 }, (_, index) => ({ sequence: index, timestamp: index })),
		});

		expect(result.success).toBe(false);
	});

	test("rejects scalar and malformed summary events", () => {
		expect(
			EngineEventBatchSchema.safeParse({
				events: [{ sequence: 1, timestamp: 1, summaryEvent: "not-an-object" }],
			}).success,
		).toBe(false);
		expect(
			EngineEventBatchSchema.safeParse({
				events: [{ sequence: 1, timestamp: 1, summaryEvent: { resourceChanges: 3 } }],
			}).success,
		).toBe(false);
	});

	test("accepts Pulumi large-state batch decrypt requests", () => {
		const result = BatchDecryptRequestSchema.safeParse({
			ciphertexts: Array.from({ length: 160 }, () => "Y2lwaGVydGV4dA=="),
		});

		expect(result.success).toBe(true);
	});

	test("rejects batch crypt requests over maximum", () => {
		expect(
			BatchEncryptRequestSchema.safeParse({
				plaintexts: Array.from({ length: MAX_BATCH_CRYPT_ITEMS + 1 }, () => "YQ=="),
			}).success,
		).toBe(false);

		expect(
			BatchDecryptRequestSchema.safeParse({
				ciphertexts: Array.from({ length: MAX_BATCH_CRYPT_ITEMS + 1 }, () => "Y2lwaGVydGV4dA=="),
			}).success,
		).toBe(false);
	});

	test("rejects plaintexts over 1 MiB", () => {
		const tooLarge = "a".repeat(MAX_STRING_LENGTH + 1);

		expect(EncryptValueRequestSchema.safeParse({ plaintext: tooLarge }).success).toBe(false);
		expect(BatchEncryptRequestSchema.safeParse({ plaintexts: [tooLarge] }).success).toBe(false);
	});

	test("accepts valid Pulumi request bodies", () => {
		expect(
			PatchUpdateCheckpointRequestSchema.safeParse({
				isInvalid: false,
				version: 3,
				features: [],
				deployment: { resources: [] },
			}).success,
		).toBe(true);

		expect(
			PatchUpdateVerbatimCheckpointRequestSchema.safeParse({
				version: 3,
				sequenceNumber: 1,
				untypedDeployment: { version: 3, deployment: { resources: [] } },
			}).success,
		).toBe(true);

		expect(
			PatchUpdateCheckpointDeltaRequestSchema.safeParse({
				version: 1,
				checkpointHash: "a".repeat(64),
				sequenceNumber: 1,
				deploymentDelta: [{ span: { start: { offset: 0 }, end: { offset: 0 } }, newText: "{}" }],
			}).success,
		).toBe(true);

		expect(
			EngineEventBatchSchema.safeParse({
				events: [{ sequence: 1, timestamp: 1 }],
			}).success,
		).toBe(true);

		expect(
			JournalEntriesSchema.safeParse({
				entries: [
					{
						version: 1,
						kind: 1,
						operationID: 1,
						sequenceID: 1,
						pendingReplacementOld: 0,
						pendingReplacementNew: 1,
						deleteOld: 0,
						deleteNew: 1,
						isRefresh: true,
					},
					{
						version: 1,
						kind: 0,
						operationID: 2,
						sequenceID: 2,
					},
				],
			}).success,
		).toBe(true);

		expect(
			UntypedDeploymentSchema.safeParse({
				version: 3,
				deployment: { resources: [] },
			}).success,
		).toBe(true);

		expect(EncryptValueRequestSchema.safeParse({ plaintext: "aGVsbG8=" }).success).toBe(true);
		expect(BatchEncryptRequestSchema.safeParse({ plaintexts: ["YQ==", "Yg=="] }).success).toBe(
			true,
		);
		expect(BatchDecryptRequestSchema.safeParse({ ciphertexts: ["Y2lwaGVydGV4dA=="] }).success).toBe(
			true,
		);
		expect(
			RenewUpdateLeaseRequestSchema.safeParse({ token: "lease-token", duration: 300 }).success,
		).toBe(true);
	});

	test("accepts deployment schema v1 through v3", () => {
		for (const version of [1, 2, 3]) {
			expect(
				PatchUpdateCheckpointRequestSchema.safeParse({ version, deployment: {} }).success,
			).toBe(true);
			expect(
				PatchUpdateVerbatimCheckpointRequestSchema.safeParse({
					version,
					sequenceNumber: 1,
					untypedDeployment: { version, deployment: {} },
				}).success,
			).toBe(true);
			expect(UntypedDeploymentSchema.safeParse({ version, deployment: {} }).success).toBe(true);
		}
	});

	test("rejects deployment schema v4 on every checkpoint and import path", () => {
		expect(
			PatchUpdateCheckpointRequestSchema.safeParse({ version: 4, deployment: {} }).success,
		).toBe(false);
		expect(
			PatchUpdateVerbatimCheckpointRequestSchema.safeParse({
				version: 4,
				sequenceNumber: 1,
				untypedDeployment: { version: 4, deployment: {} },
			}).success,
		).toBe(false);
		expect(
			PatchUpdateCheckpointDeltaRequestSchema.safeParse({
				version: 4,
				checkpointHash: "a".repeat(64),
				sequenceNumber: 1,
				deploymentDelta: [],
			}).success,
		).toBe(false);
		expect(UntypedDeploymentSchema.safeParse({ version: 4, deployment: {} }).success).toBe(false);
	});

	test("rejects non-empty deployment features", () => {
		expect(
			PatchUpdateCheckpointRequestSchema.safeParse({
				version: 3,
				features: ["snippets"],
				deployment: {},
			}).success,
		).toBe(false);
		expect(
			UntypedDeploymentSchema.safeParse({
				version: 3,
				features: ["extensionRef"],
				deployment: {},
			}).success,
		).toBe(false);
	});

	test("requires a SHA-256 checkpointHash on delta requests", () => {
		for (const checkpointHash of [undefined, "", "hash", "z".repeat(64)]) {
			expect(
				PatchUpdateCheckpointDeltaRequestSchema.safeParse({
					version: 3,
					checkpointHash,
					sequenceNumber: 1,
					deploymentDelta: [],
				}).success,
			).toBe(false);
		}
	});
});
