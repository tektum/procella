import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { AesCryptoService } from "@procella/crypto";
import { checkpoints, type Database, journalEntries } from "@procella/db";
import { PostgresStacksService, type StackInfo } from "@procella/stacks";
import { type BlobStorage, LocalBlobStorage } from "@procella/storage";
import {
	BadRequestError,
	CheckpointNotFoundError,
	JournalEntryBegin,
	JournalEntrySuccess,
	LeaseExpiredError,
	UpdateConflictError,
	UpdateNotFoundError,
} from "@procella/types";
import {
	BLOB_THRESHOLD,
	CheckpointSequenceError,
	DELTA_BASE_CHECKPOINT_VERSION,
	hashDeploymentText,
	ImportConflictError,
	PostgresUpdatesService,
} from "@procella/updates";
import { and, asc, eq } from "drizzle-orm";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getTestDb, truncateTables } from "./setup.js";

let db: Database;
let stacksService: PostgresStacksService;
let updatesService: PostgresUpdatesService;
let blobDir: string;

beforeAll(async () => {
	db = getTestDb();
	stacksService = new PostgresStacksService({ db });
	blobDir = await mkdtemp(path.join(tmpdir(), "procella-int-blobs-"));
	const storage = new LocalBlobStorage(blobDir);
	// Use deterministic dev key for tests
	const keyHex = "a".repeat(64);
	const crypto = new AesCryptoService(keyHex);
	updatesService = new PostgresUpdatesService({ db, storage, crypto });
});

afterAll(async () => {
	await import("node:fs/promises").then((fs) => fs.rm(blobDir, { recursive: true, force: true }).catch(() => {}));
});

afterEach(async () => {
	await truncateTables();
});

async function seedStack(tenant = "tenant-1"): Promise<StackInfo> {
	return stacksService.createStack(tenant, "org-1", "test-project", `stack-${Date.now()}`);
}

describe("PostgresUpdatesService — integration", () => {
	// ========================================================================
	// createUpdate
	// ========================================================================

	describe("createUpdate", () => {
		test("creates update with correct initial state", async () => {
			const stack = await seedStack();
			const result = await updatesService.createUpdate(stack.id, "update");
			expect(result.updateID).toBeTruthy();
		});

		test("persists update environment through completion", async () => {
			const stack = await seedStack();
			const environment = {
				"vcs.owner": "octocat",
				"vcs.repo": "hello-world",
				"ci.pr.number": "42",
				"ci.pr.headSHA": "abc123",
			};
			const created = await updatesService.createUpdate(
				stack.id,
				"preview",
				undefined,
				undefined,
				undefined,
				environment,
			);
			await updatesService.startUpdate(created.updateID, {});

			await updatesService.completeUpdate(created.updateID, { status: "succeeded" });
			const context = await updatesService.getUpdateContext(created.updateID);

			expect(context).toEqual({ stackId: stack.id, environment });
		});

		test("rejects second active update on same stack (unique constraint)", async () => {
			const stack = await seedStack();
			await updatesService.createUpdate(stack.id, "update");
			await expect(updatesService.createUpdate(stack.id, "update")).rejects.toBeInstanceOf(
				UpdateConflictError,
			);
		});

		test("allows new update after previous completes", async () => {
			const stack = await seedStack();
			const first = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(first.updateID, {});
			await updatesService.completeUpdate(first.updateID, { status: "succeeded" });

			// Second update should work now
			const second = await updatesService.createUpdate(stack.id, "update");
			expect(second.updateID).toBeTruthy();
			expect(second.updateID).not.toBe(first.updateID);
		});
	});

	// ========================================================================
	// startUpdate
	// ========================================================================

	describe("startUpdate", () => {
		test("returns lease token and version", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			const started = await updatesService.startUpdate(created.updateID, {});
			expect(started.token).toBeTruthy();
			expect(started.version).toBeGreaterThanOrEqual(1);
			expect(started.tokenExpiration).toBeTruthy();
		});

		test("throws UpdateNotFoundError for missing update", async () => {
			await expect(
				updatesService.startUpdate("00000000-0000-0000-0000-000000000000", {}),
			).rejects.toBeInstanceOf(UpdateNotFoundError);
		});
	});

	// ========================================================================
	// completeUpdate
	// ========================================================================

	describe("completeUpdate", () => {
		test("marks update as succeeded", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});
			await updatesService.completeUpdate(created.updateID, { status: "succeeded" });

			const result = await updatesService.getUpdate(created.updateID);
			expect(result.status).toBe("succeeded");
		});

		test("marks update as failed", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});
			await updatesService.completeUpdate(created.updateID, { status: "failed" });

			const result = await updatesService.getUpdate(created.updateID);
			expect(result.status).toBe("failed");
		});

		test("clears active update lock on stack", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});
			await updatesService.completeUpdate(created.updateID, { status: "succeeded" });

			// Should allow new update
			const second = await updatesService.createUpdate(stack.id, "update");
			expect(second.updateID).toBeTruthy();
		});
	});

	// ========================================================================
	// cancelUpdate
	// ========================================================================

	describe("cancelUpdate", () => {
		test("cancels active update", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});
			await updatesService.cancelUpdate(created.updateID);

			const result = await updatesService.getUpdate(created.updateID);
			expect(result.status).toBe("cancelled");
		});

		test("allows new update after cancel", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});
			await updatesService.cancelUpdate(created.updateID);

			const second = await updatesService.createUpdate(stack.id, "update");
			expect(second.updateID).toBeTruthy();
		});

		test("rejects checkpoint writes after cancel", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});
			await updatesService.cancelUpdate(created.updateID);

			await expect(
				updatesService.patchCheckpoint(created.updateID, {
					isInvalid: false,
					version: 3,
					deployment: { resources: [] },
				}),
			).rejects.toBeInstanceOf(LeaseExpiredError);
		});
	});

	// ========================================================================
	// events
	// ========================================================================

	describe("postEvents / getUpdateEvents", () => {
		test("posts and retrieves events", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});

			await updatesService.postEvents(created.updateID, {
				events: [
					{ sequence: 1, timestamp: 1000, preludeEvent: { config: {} } } as never,
					{ sequence: 2, timestamp: 2000, summaryEvent: { resourceChanges: { create: 1 } } } as never,
				],
			});

			const events = await updatesService.getUpdateEvents(created.updateID);
			expect(events.events).toBeArray();
			expect(events.events.length).toBeGreaterThanOrEqual(2);
		});

		test("rejects oversized event batches", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});

			await expect(
				updatesService.postEvents(created.updateID, {
					events: Array.from({ length: 1001 }, (_, index) =>
						({ sequence: index + 1, timestamp: index, preludeEvent: { config: {} } }) as never,
					),
				}),
			).rejects.toBeInstanceOf(BadRequestError);
		});
	});

	// ========================================================================
	// getHistory
	// ========================================================================

	describe("getHistory", () => {
		test("returns update history for stack", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});
			await updatesService.completeUpdate(created.updateID, { status: "succeeded" });

			const history = await updatesService.getHistory(stack.id);
			expect(history.updates).toBeArray();
			expect(history.updates.length).toBeGreaterThanOrEqual(1);
		});

		test("returns empty for stack with no updates", async () => {
			const stack = await seedStack();
			const history = await updatesService.getHistory(stack.id);
			expect(history.updates).toHaveLength(0);
		});
	});

	// ========================================================================
	// exportStack / importStack
	// ========================================================================

	describe("export / import", () => {
		test("export returns valid empty deployment for new stack", async () => {
			const stack = await seedStack();
			const deployment = await updatesService.exportStack(stack.id);
			expect(deployment.version).toBe(3);
			expect(deployment.deployment).toBeDefined();
		});

		test("rejects import while stack has active update", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});

			await expect(
				updatesService.importStack(stack.id, {
					version: 3,
					deployment: { resources: [] },
				}),
			).rejects.toBeInstanceOf(ImportConflictError);
		});
	});

	// ========================================================================
	// encrypt / decrypt roundtrip
	// ========================================================================

	describe("encrypt / decrypt", () => {
		test("roundtrips plaintext through encrypt+decrypt", async () => {
			const stack = await seedStack();
			const fqn = `tenant-1/test-project/${stack.stackName}`;
			const stackRef = { stackId: stack.id, stackFQN: fqn };
			const plaintext = new TextEncoder().encode("my-secret-value");

			const ciphertext = await updatesService.encryptValue(stackRef, plaintext);
			expect(ciphertext).not.toEqual(plaintext);

			const decrypted = await updatesService.decryptValue(stackRef, ciphertext);
			expect(new TextDecoder().decode(decrypted)).toBe("my-secret-value");
		});

		test("batch encrypt/decrypt roundtrip", async () => {
			const stack = await seedStack();
			const fqn = `tenant-1/test-project/${stack.stackName}`;
			const stackRef = { stackId: stack.id, stackFQN: fqn };
			const values = [
				new TextEncoder().encode("secret-1"),
				new TextEncoder().encode("secret-2"),
			];

			const encrypted = await updatesService.batchEncrypt(stackRef, values);
			expect(encrypted).toHaveLength(2);

			const decrypted = await updatesService.batchDecrypt(stackRef, encrypted);
			expect(new TextDecoder().decode(decrypted[0])).toBe("secret-1");
			expect(new TextDecoder().decode(decrypted[1])).toBe("secret-2");
		});
	});

	// ========================================================================
	// lease management
	// ========================================================================

	describe("leases", () => {
		test("verifyLeaseToken succeeds with correct token", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			const started = await updatesService.startUpdate(created.updateID, {});
			if (!started.token) {
				throw new Error("lease token missing from startUpdate response");
			}
			const token = started.token;

			// Should not throw
			await updatesService.verifyLeaseToken(created.updateID, token);
		});

		test("verifyLeaseToken rejects invalid token", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});

			await expect(
				updatesService.verifyLeaseToken(created.updateID, "invalid-token"),
			).rejects.toThrow();
		});

		test("renewLease extends expiration", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			const started = await updatesService.startUpdate(created.updateID, {});
			if (!started.token) {
				throw new Error("lease token missing from startUpdate response");
			}
			const token = started.token;

			const renewed = await updatesService.renewLease(created.updateID, {
				token,
				duration: 300,
			});
			expect(renewed.token).toBe(token);
		});

		test("caps renewLease duration at 300 seconds", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			const started = await updatesService.startUpdate(created.updateID, {});
			if (!started.token) {
				throw new Error("lease token missing from startUpdate response");
			}
			const token = started.token;

			const before = Math.floor(Date.now() / 1000);
			const renewed = await updatesService.renewLease(created.updateID, {
				token,
				duration: 99_999,
			});

			expect(renewed.token).toBe(token);
			expect(renewed.tokenExpiration).toBeLessThanOrEqual(before + 301);
			expect(renewed.tokenExpiration).toBeGreaterThanOrEqual(before + 299);
		});
	});

	describe("journal + checkpoints", () => {
		test("rejects oversized journal entry batches", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});

			await expect(
				updatesService.appendJournalEntries(created.updateID, {
					entries: Array.from({ length: 10_001 }, (_, index) => ({
						version: 1,
						kind: JournalEntryBegin,
						operationID: index + 1,
						sequenceID: index + 1,
					})),
				}),
			).rejects.toBeInstanceOf(BadRequestError);
		});

		test("persists every replay-relevant journal field", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});

			await updatesService.appendJournalEntries(created.updateID, {
				entries: [
					{
						version: 1,
						kind: JournalEntrySuccess,
						operationID: 7,
						sequenceID: 11,
						state: {
							urn: "urn:pulumi:dev::test-project::test:index:Thing::example",
							custom: true,
							type: "test:index:Thing",
						},
						pendingReplacementOld: 2,
						pendingReplacementNew: 7,
						deleteOld: 3,
						deleteNew: 7,
						isRefresh: true,
					},
				],
			});

			const [persisted] = await db
				.select()
				.from(journalEntries)
				.where(eq(journalEntries.updateId, created.updateID));
			expect(persisted).toMatchObject({
				pendingReplacementOld: 2n,
				pendingReplacementNew: 7n,
				deleteOld: 3n,
				deleteNew: 7n,
				isRefresh: true,
			});
		});

		test("replays from the pre-update snapshot after a service restart", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});
			const resourceA = {
				urn: "urn:pulumi:dev::test-project::test:index:Thing::a",
				custom: true,
				type: "test:index:Thing",
			};
			const resourceB = {
				urn: "urn:pulumi:dev::test-project::test:index:Thing::b",
				custom: true,
				type: "test:index:Thing",
			};

			await updatesService.appendJournalEntries(created.updateID, {
				entries: [
					{
						version: 1,
						kind: JournalEntrySuccess,
						operationID: 1,
						sequenceID: 1,
						state: resourceA,
					},
				],
			});

			const restartedService = new PostgresUpdatesService({ db,
				storage: new LocalBlobStorage(blobDir),
				crypto: new AesCryptoService("a".repeat(64)),
			});
			await restartedService.appendJournalEntries(created.updateID, {
				entries: [
					{
						version: 1,
						kind: JournalEntrySuccess,
						operationID: 2,
						sequenceID: 2,
						state: resourceB,
					},
				],
			});

			const exported = await restartedService.exportStack(stack.id);
			// UntypedDeployment intentionally leaves the deployment payload untyped.
			const deployment = exported.deployment as { resources: Array<{ urn: string }> };
			const { resources } = deployment;
			expect(resources.map((resource) => resource.urn)).toEqual([resourceA.urn, resourceB.urn]);
		});

		test("retries an identical checkpoint after blob persistence fails", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});
			const localStorage = new LocalBlobStorage(blobDir);
			let putAttempts = 0;
			const flakyStorage: BlobStorage = {
				get: (key) => localStorage.get(key),
				put: async (key, data) => {
					putAttempts++;
					if (putAttempts === 1) throw new Error("injected storage failure");
					await localStorage.put(key, data);
				},
				delete: (key) => localStorage.delete(key),
				exists: (key) => localStorage.exists(key),
			};
			const retryingService = new PostgresUpdatesService({ db,
				storage: flakyStorage,
				crypto: new AesCryptoService("a".repeat(64)),
			});
			const request = {
				isInvalid: false,
				version: 3,
				deployment: { resources: [], payload: "x".repeat(BLOB_THRESHOLD + 1) },
			};

			await expect(retryingService.patchCheckpoint(created.updateID, request)).rejects.toThrow(
				"injected storage failure",
			);
			await retryingService.patchCheckpoint(created.updateID, request);

			expect(putAttempts).toBe(2);
			const persisted = await db
				.select()
				.from(checkpoints)
				.where(eq(checkpoints.updateId, created.updateID));
			expect(persisted).toHaveLength(1);
		});

		test("concurrent checkpoint writes use sequential versions without conflicts", async () => {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});

			const firstDeployment = {
				manifest: { time: new Date().toISOString(), magic: "", version: "" },
				resources: [{ urn: "urn:pulumi:stack::proj::test:index:Thing::one", custom: true }],
			};
			const secondDeployment = {
				manifest: { time: new Date().toISOString(), magic: "", version: "" },
				resources: [{ urn: "urn:pulumi:stack::proj::test:index:Thing::two", custom: true }],
			};

			const results = await Promise.allSettled([
				updatesService.patchCheckpoint(created.updateID, {
					isInvalid: false,
					version: 3,
					deployment: firstDeployment,
				}),
				updatesService.patchCheckpoint(created.updateID, {
					isInvalid: false,
					version: 3,
					deployment: secondDeployment,
				}),
			]);

			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);

			const persisted = await db
				.select({ version: checkpoints.version })
				.from(checkpoints)
				.where(eq(checkpoints.updateId, created.updateID))
				.orderBy(asc(checkpoints.version));

			expect(persisted.map((row) => row.version)).toEqual([1, 2]);
		});
	});

	describe("verbatim + delta checkpoints", () => {
		// Byte-hostile baseline: `1.0` and `1e30` renormalize and `\u0041` re-escapes under
		// JSON.parse + JSON.stringify, and the resource keys are not in sorted order.
		const BASE_TEXT =
			'{"version":3,"deployment":{"manifest":{"time":"2026-01-01T00:00:00Z","magic":"","version":""},"resources":[{"urn":"urn:a","custom":true,"weight":1.0,"note":"\\u0041","big":1e30}]}}';

		async function startUpdate() {
			const stack = await seedStack();
			const created = await updatesService.createUpdate(stack.id, "update");
			await updatesService.startUpdate(created.updateID, {});
			return { stack, updateId: created.updateID };
		}

		function replaceEdit(before: string, needle: string, newText: string) {
			const offset = new TextEncoder().encode(before.slice(0, before.indexOf(needle))).length;
			return [
				{
					span: {
						start: { line: 1, column: 0, offset },
						end: { line: 1, column: 0, offset: offset + new TextEncoder().encode(needle).length },
					},
					newText,
				},
			];
		}

		async function readBaseText(updateId: string): Promise<string> {
			const [row] = await db
				.select()
				.from(checkpoints)
				.where(
					and(eq(checkpoints.updateId, updateId), eq(checkpoints.version, DELTA_BASE_CHECKPOINT_VERSION)),
				);
			if (!row) throw new Error("delta baseline row missing");
			expect(row.isDelta).toBe(true);
			const meta = row.data as { sequenceNumber: number; text?: string };
			if (row.blobKey) {
				const raw = await new LocalBlobStorage(blobDir).get(row.blobKey);
				if (!raw) throw new Error("delta baseline blob missing");
				return new TextDecoder().decode(raw);
			}
			if (typeof meta.text !== "string") throw new Error("delta baseline text missing");
			return meta.text;
		}

		test("retains the exact verbatim bytes as the delta baseline", async () => {
			const { updateId } = await startUpdate();
			await updatesService.patchCheckpointVerbatim(updateId, {
				version: 3,
				sequenceNumber: 1,
				untypedDeploymentText: BASE_TEXT,
			});

			const stored = await readBaseText(updateId);
			expect(stored).toBe(BASE_TEXT);
			// Proof the baseline is not a parse/stringify round-trip.
			expect(JSON.stringify(JSON.parse(BASE_TEXT))).not.toBe(BASE_TEXT);
		});


		for (const terminal of ["complete", "cancel"] as const) {
			test(`removes the delta baseline row and blob on ${terminal}`, async () => {
				const { updateId } = await startUpdate();
				const storage = new LocalBlobStorage(blobDir);
				const largeText = `{"version":3,"deployment":{"resources":[],"filler":"${"x".repeat(BLOB_THRESHOLD + 1)}"}}`;
				await updatesService.patchCheckpointVerbatim(updateId, {
					version: 3,
					sequenceNumber: 1,
					untypedDeploymentText: largeText,
				});

				const [sidecar] = await db
					.select({ blobKey: checkpoints.blobKey })
					.from(checkpoints)
					.where(
						and(
							eq(checkpoints.updateId, updateId),
							eq(checkpoints.version, DELTA_BASE_CHECKPOINT_VERSION),
						),
					);
				if (!sidecar?.blobKey) throw new Error("delta baseline blob missing");
				expect(await storage.exists(sidecar.blobKey)).toBe(true);

				if (terminal === "complete") {
					await updatesService.completeUpdate(updateId, { status: "succeeded" });
				} else {
					await updatesService.cancelUpdate(updateId);
				}

				const remainingSidecars = await db
					.select()
					.from(checkpoints)
					.where(
						and(
							eq(checkpoints.updateId, updateId),
							eq(checkpoints.version, DELTA_BASE_CHECKPOINT_VERSION),
						),
					);
				expect(remainingSidecars).toEqual([]);
				expect(await storage.exists(sidecar.blobKey)).toBe(false);
			});
		}

		test("applies two consecutive deltas and exports the canonical v3 deployment", async () => {
			const { stack, updateId } = await startUpdate();
			await updatesService.patchCheckpointVerbatim(updateId, {
				version: 3,
				sequenceNumber: 1,
				untypedDeploymentText: BASE_TEXT,
			});

			const firstText = BASE_TEXT.replace('"urn:a"', '"urn:b"');
			await updatesService.patchCheckpointDelta(updateId, {
				version: 3,
				sequenceNumber: 2,
				checkpointHash: hashDeploymentText(firstText),
				deploymentDelta: replaceEdit(BASE_TEXT, '"urn:a"', '"urn:b"'),
			});
			expect(await readBaseText(updateId)).toBe(firstText);

			const secondText = firstText.replace('"weight":1.0', '"weight":2.5');
			await updatesService.patchCheckpointDelta(updateId, {
				version: 3,
				sequenceNumber: 3,
				checkpointHash: hashDeploymentText(secondText),
				deploymentDelta: replaceEdit(firstText, '"weight":1.0', '"weight":2.5'),
			});
			expect(await readBaseText(updateId)).toBe(secondText);

			const exported = await updatesService.exportStack(stack.id);
			expect(exported.version).toBe(3);
			expect(exported.deployment).toEqual(JSON.parse(secondText).deployment);

			// Export must never surface the baseline sidecar row.
			const rows = await db
				.select({ version: checkpoints.version, isDelta: checkpoints.isDelta })
				.from(checkpoints)
				.where(eq(checkpoints.updateId, updateId))
				.orderBy(asc(checkpoints.version));
			expect(rows).toEqual([
				{ version: 0, isDelta: true },
				{ version: 1, isDelta: false },
				{ version: 2, isDelta: false },
				{ version: 3, isDelta: false },
			]);
		});

		test("version-selected export cannot expose the delta baseline sidecar", async () => {
			const { stack, updateId } = await startUpdate();
			await updatesService.patchCheckpointVerbatim(updateId, {
				version: 3,
				sequenceNumber: 1,
				untypedDeploymentText: BASE_TEXT,
			});
			const nextText = BASE_TEXT.replace('"urn:a"', '"urn:b"');
			await updatesService.patchCheckpointDelta(updateId, {
				version: 3,
				sequenceNumber: 2,
				checkpointHash: hashDeploymentText(nextText),
				deploymentDelta: replaceEdit(BASE_TEXT, '"urn:a"', '"urn:b"'),
			});

			// The sidecar row really is present at the reserved version, so the export filter is
			// what keeps it unreachable — not an absence of data.
			const sidecar = await db
				.select({ version: checkpoints.version, isDelta: checkpoints.isDelta })
				.from(checkpoints)
				.where(
					and(
						eq(checkpoints.updateId, updateId),
						eq(checkpoints.version, DELTA_BASE_CHECKPOINT_VERSION),
					),
				);
			expect(sidecar).toEqual([{ version: DELTA_BASE_CHECKPOINT_VERSION, isDelta: true }]);

			// Explicitly requesting the reserved version must not return the raw baseline text.
			await expect(
				updatesService.exportStack(stack.id, DELTA_BASE_CHECKPOINT_VERSION),
			).rejects.toBeInstanceOf(CheckpointNotFoundError);

			// Canonical exports are unaffected.
			const canonical = JSON.parse(nextText).deployment;
			const latest = await updatesService.exportStack(stack.id);
			expect(latest.version).toBe(3);
			expect(latest.deployment).toEqual(canonical);

			const versioned = await updatesService.exportStack(stack.id, 2);
			expect(versioned.version).toBe(3);
			expect(versioned.deployment).toEqual(canonical);
		});

		test("treats a replay of the same sequence number as a no-op", async () => {
			const { updateId } = await startUpdate();
			await updatesService.patchCheckpointVerbatim(updateId, {
				version: 3,
				sequenceNumber: 1,
				untypedDeploymentText: BASE_TEXT,
			});
			const nextText = BASE_TEXT.replace('"urn:a"', '"urn:b"');
			const delta = {
				version: 3,
				sequenceNumber: 2,
				checkpointHash: hashDeploymentText(nextText),
				deploymentDelta: replaceEdit(BASE_TEXT, '"urn:a"', '"urn:b"'),
			};

			await updatesService.patchCheckpointDelta(updateId, delta);
			await updatesService.patchCheckpointDelta(updateId, delta);
			// Verbatim fallback carrying the already-stored bytes at the same sequence.
			await updatesService.patchCheckpointVerbatim(updateId, {
				version: 3,
				sequenceNumber: 2,
				untypedDeploymentText: nextText,
			});

			expect(await readBaseText(updateId)).toBe(nextText);
			const rows = await db
				.select({ version: checkpoints.version })
				.from(checkpoints)
				.where(eq(checkpoints.updateId, updateId))
				.orderBy(asc(checkpoints.version));
			expect(rows.map((row) => row.version)).toEqual([0, 1, 2]);
		});

		test("rejects stale, conflicting, and out-of-order sequence numbers without changing state", async () => {
			const { updateId } = await startUpdate();
			await updatesService.patchCheckpointVerbatim(updateId, {
				version: 3,
				sequenceNumber: 2,
				untypedDeploymentText: BASE_TEXT,
			});

			const conflicting = BASE_TEXT.replace('"urn:a"', '"urn:z"');
			// Stale.
			await expect(
				updatesService.patchCheckpointVerbatim(updateId, {
					version: 3,
					sequenceNumber: 1,
					untypedDeploymentText: conflicting,
				}),
			).rejects.toBeInstanceOf(CheckpointSequenceError);
			// Different content at an already-used sequence number.
			await expect(
				updatesService.patchCheckpointVerbatim(updateId, {
					version: 3,
					sequenceNumber: 2,
					untypedDeploymentText: conflicting,
				}),
			).rejects.toBeInstanceOf(CheckpointSequenceError);
			// Gap.
			await expect(
				updatesService.patchCheckpointDelta(updateId, {
					version: 3,
					sequenceNumber: 5,
					checkpointHash: hashDeploymentText(conflicting),
					deploymentDelta: replaceEdit(BASE_TEXT, '"urn:a"', '"urn:z"'),
				}),
			).rejects.toBeInstanceOf(CheckpointSequenceError);

			expect(await readBaseText(updateId)).toBe(BASE_TEXT);
			const rows = await db
				.select({ version: checkpoints.version })
				.from(checkpoints)
				.where(eq(checkpoints.updateId, updateId))
				.orderBy(asc(checkpoints.version));
			expect(rows.map((row) => row.version)).toEqual([0, 1]);
		});

		test("leaves the latest checkpoint unchanged on hash mismatch and corrupt deltas", async () => {
			const { stack, updateId } = await startUpdate();
			await updatesService.patchCheckpointVerbatim(updateId, {
				version: 3,
				sequenceNumber: 1,
				untypedDeploymentText: BASE_TEXT,
			});
			const before = await updatesService.exportStack(stack.id);

			// Hash does not match the applied result.
			await expect(
				updatesService.patchCheckpointDelta(updateId, {
					version: 3,
					sequenceNumber: 2,
					checkpointHash: "b".repeat(64),
					deploymentDelta: replaceEdit(BASE_TEXT, '"urn:a"', '"urn:b"'),
				}),
			).rejects.toBeInstanceOf(BadRequestError);

			// Out-of-bounds span.
			await expect(
				updatesService.patchCheckpointDelta(updateId, {
					version: 3,
					sequenceNumber: 2,
					checkpointHash: hashDeploymentText(BASE_TEXT),
					deploymentDelta: [
						{
							span: {
								start: { line: 1, column: 0, offset: 0 },
								end: { line: 1, column: 0, offset: 10_000 },
							},
							newText: "{}",
						},
					],
				}),
			).rejects.toBeInstanceOf(BadRequestError);

			// Applies cleanly and hashes correctly, but is no longer valid JSON.
			const corruptText = BASE_TEXT.replace('"urn:a"', '"urn:a');
			await expect(
				updatesService.patchCheckpointDelta(updateId, {
					version: 3,
					sequenceNumber: 2,
					checkpointHash: hashDeploymentText(corruptText),
					deploymentDelta: replaceEdit(BASE_TEXT, '"urn:a"', '"urn:a'),
				}),
			).rejects.toBeInstanceOf(BadRequestError);

			expect(await readBaseText(updateId)).toBe(BASE_TEXT);
			expect(await updatesService.exportStack(stack.id)).toEqual(before);
		});

		test("accepts a full verbatim fallback at the rejected delta sequence exactly once", async () => {
			const { stack, updateId } = await startUpdate();
			await updatesService.patchCheckpointVerbatim(updateId, {
				version: 3,
				sequenceNumber: 1,
				untypedDeploymentText: BASE_TEXT,
			});
			const before = await updatesService.exportStack(stack.id);
			const rejectedText = BASE_TEXT.replace('"urn:a"', '"urn:rejected"');

			await expect(
				updatesService.patchCheckpointDelta(updateId, {
					version: 3,
					sequenceNumber: 2,
					checkpointHash: "b".repeat(64),
					deploymentDelta: replaceEdit(BASE_TEXT, '"urn:a"', '"urn:rejected"'),
				}),
			).rejects.toBeInstanceOf(BadRequestError);
			expect(hashDeploymentText(rejectedText)).not.toBe("b".repeat(64));
			expect(await readBaseText(updateId)).toBe(BASE_TEXT);
			expect(await updatesService.exportStack(stack.id)).toEqual(before);

			const rowsAfterRejectedDelta = await db
				.select({ version: checkpoints.version, isDelta: checkpoints.isDelta })
				.from(checkpoints)
				.where(eq(checkpoints.updateId, updateId))
				.orderBy(asc(checkpoints.version));
			expect(rowsAfterRejectedDelta).toEqual([
				{ version: DELTA_BASE_CHECKPOINT_VERSION, isDelta: true },
				{ version: 1, isDelta: false },
			]);

			const fallbackText = BASE_TEXT.replace('"urn:a"', '"urn:fallback"');
			await updatesService.patchCheckpointVerbatim(updateId, {
				version: 3,
				sequenceNumber: 2,
				untypedDeploymentText: fallbackText,
			});

			expect(await readBaseText(updateId)).toBe(fallbackText);
			const rowsAfterFallback = await db
				.select({ version: checkpoints.version, isDelta: checkpoints.isDelta, data: checkpoints.data })
				.from(checkpoints)
				.where(eq(checkpoints.updateId, updateId))
				.orderBy(asc(checkpoints.version));
			expect(rowsAfterFallback).toHaveLength(3);
			expect(rowsAfterFallback.map(({ version, isDelta }) => ({ version, isDelta }))).toEqual([
				{ version: DELTA_BASE_CHECKPOINT_VERSION, isDelta: true },
				{ version: 1, isDelta: false },
				{ version: 2, isDelta: false },
			]);
			expect(rowsAfterFallback[0]?.data).toMatchObject({ sequenceNumber: 2 });

			const exported = await updatesService.exportStack(stack.id);
			expect(exported.version).toBe(3);
			expect(exported.deployment).toEqual(JSON.parse(fallbackText).deployment);
		});

		test("rejects a delta with no retained baseline so the CLI falls back to verbatim", async () => {
			const { updateId } = await startUpdate();
			await expect(
				updatesService.patchCheckpointDelta(updateId, {
					version: 3,
					sequenceNumber: 1,
					checkpointHash: hashDeploymentText(BASE_TEXT),
					deploymentDelta: [],
				}),
			).rejects.toBeInstanceOf(BadRequestError);
		});

		test("lets only one of two concurrent same-base writers commit", async () => {
			const { updateId } = await startUpdate();
			await updatesService.patchCheckpointVerbatim(updateId, {
				version: 3,
				sequenceNumber: 1,
				untypedDeploymentText: BASE_TEXT,
			});

			const textB = BASE_TEXT.replace('"urn:a"', '"urn:b"');
			const textC = BASE_TEXT.replace('"urn:a"', '"urn:c"');
			const results = await Promise.allSettled([
				updatesService.patchCheckpointDelta(updateId, {
					version: 3,
					sequenceNumber: 2,
					checkpointHash: hashDeploymentText(textB),
					deploymentDelta: replaceEdit(BASE_TEXT, '"urn:a"', '"urn:b"'),
				}),
				updatesService.patchCheckpointDelta(updateId, {
					version: 3,
					sequenceNumber: 2,
					checkpointHash: hashDeploymentText(textC),
					deploymentDelta: replaceEdit(BASE_TEXT, '"urn:a"', '"urn:c"'),
				}),
			]);

			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			const stored = await readBaseText(updateId);
			expect([textB, textC]).toContain(stored);
		});

		test("rejects unsupported envelopes and keeps v3 working", async () => {
			const { updateId } = await startUpdate();

			await expect(
				updatesService.patchCheckpointVerbatim(updateId, {
					version: 3,
					sequenceNumber: 1,
					untypedDeploymentText: '{"version":4,"deployment":{"resources":[]}}',
				}),
			).rejects.toBeInstanceOf(BadRequestError);
			await expect(
				updatesService.patchCheckpointVerbatim(updateId, {
					version: 3,
					sequenceNumber: 1,
					untypedDeploymentText:
						'{"version":3,"features":["snippets"],"deployment":{"resources":[]}}',
				}),
			).rejects.toBeInstanceOf(BadRequestError);
			await expect(
				updatesService.patchCheckpointVerbatim(updateId, {
					version: 4,
					sequenceNumber: 1,
					untypedDeploymentText: '{"version":3,"deployment":{"resources":[]}}',
				}),
			).rejects.toBeInstanceOf(BadRequestError);
			await expect(
				updatesService.patchCheckpoint(updateId, {
					isInvalid: false,
					version: 4,
					deployment: { resources: [] },
				}),
			).rejects.toBeInstanceOf(BadRequestError);

			// Nothing was persisted by any rejected envelope.
			expect(
				await db.select().from(checkpoints).where(eq(checkpoints.updateId, updateId)),
			).toHaveLength(0);

			await updatesService.patchCheckpointVerbatim(updateId, {
				version: 3,
				sequenceNumber: 1,
				untypedDeploymentText: BASE_TEXT,
			});
			expect(await readBaseText(updateId)).toBe(BASE_TEXT);
		});

		test("round-trips a baseline larger than the blob threshold", async () => {
			const { stack, updateId } = await startUpdate();
			const filler = "x".repeat(BLOB_THRESHOLD + 1);
			const bigText = `{"version":3,"deployment":{"resources":[],"filler":"${filler}","n":1}}`;
			await updatesService.patchCheckpointVerbatim(updateId, {
				version: 3,
				sequenceNumber: 1,
				untypedDeploymentText: bigText,
			});
			expect(await readBaseText(updateId)).toBe(bigText);

			const nextText = bigText.replace('"n":1', '"n":2');
			await updatesService.patchCheckpointDelta(updateId, {
				version: 3,
				sequenceNumber: 2,
				checkpointHash: hashDeploymentText(nextText),
				deploymentDelta: replaceEdit(bigText, '"n":1', '"n":2'),
			});

			expect(await readBaseText(updateId)).toBe(nextText);
			const exported = await updatesService.exportStack(stack.id);
			expect(exported.deployment).toEqual(JSON.parse(nextText).deployment);
		});

		test("does not delete the committed baseline when the replacement transaction rolls back", async () => {
			const rollbackBlobDir = path.join(blobDir, `delta-rollback-${Date.now()}`);
			const localStorage = new LocalBlobStorage(rollbackBlobDir);
			const deleteAttempts: string[] = [];
			let rejectWrites = false;
			const storage: BlobStorage = {
				get: (key) => localStorage.get(key),
				put: async (key, data) => {
					if (rejectWrites) throw new Error("injected replacement write failure");
					await localStorage.put(key, data);
				},
				delete: async (key) => {
					deleteAttempts.push(key);
					await localStorage.delete(key);
				},
				exists: (key) => localStorage.exists(key),
			};
			const service = new PostgresUpdatesService({ db,
				storage,
				crypto: new AesCryptoService("a".repeat(64)),
			});
			const stack = await seedStack();
			const created = await service.createUpdate(stack.id, "update");
			await service.startUpdate(created.updateID, {});
			const bigText = `{"version":3,"deployment":{"resources":[],"filler":"${"x".repeat(BLOB_THRESHOLD + 1)}","n":1}}`;
			await service.patchCheckpointVerbatim(created.updateID, {
				version: 3,
				sequenceNumber: 1,
				untypedDeploymentText: bigText,
			});
			const [sidecarBefore] = await db
				.select({ blobKey: checkpoints.blobKey })
				.from(checkpoints)
				.where(
					and(
						eq(checkpoints.updateId, created.updateID),
						eq(checkpoints.version, DELTA_BASE_CHECKPOINT_VERSION),
					),
				);
			if (!sidecarBefore?.blobKey) throw new Error("initial baseline blob key missing");

			rejectWrites = true;
			const nextText = bigText.replace('"n":1', '"n":2');
			await expect(
				service.patchCheckpointDelta(created.updateID, {
					version: 3,
					sequenceNumber: 2,
					checkpointHash: hashDeploymentText(nextText),
					deploymentDelta: replaceEdit(bigText, '"n":1', '"n":2'),
				}),
			).rejects.toThrow("injected replacement write failure");

			expect(deleteAttempts).toEqual([]);
			expect(await localStorage.exists(sidecarBefore.blobKey)).toBe(true);
			const [sidecarAfter] = await db
				.select({ blobKey: checkpoints.blobKey, data: checkpoints.data })
				.from(checkpoints)
				.where(
					and(
						eq(checkpoints.updateId, created.updateID),
						eq(checkpoints.version, DELTA_BASE_CHECKPOINT_VERSION),
					),
				);
			expect(sidecarAfter).toEqual(sidecarBefore.blobKey ? { blobKey: sidecarBefore.blobKey, data: { sequenceNumber: 1 } } : undefined);
			expect(await service.exportStack(stack.id)).toEqual({
				version: 3,
				deployment: JSON.parse(bigText).deployment,
			});
		});

		test("keeps committed state readable when superseded baseline cleanup fails", async () => {
			const cleanupBlobDir = path.join(blobDir, `delta-cleanup-failure-${Date.now()}`);
			const localStorage = new LocalBlobStorage(cleanupBlobDir);
			const deleteAttempts: string[] = [];
			const storage: BlobStorage = {
				get: (key) => localStorage.get(key),
				put: (key, data) => localStorage.put(key, data),
				delete: async (key) => {
					deleteAttempts.push(key);
					throw new Error("injected cleanup failure");
				},
				exists: (key) => localStorage.exists(key),
			};
			const service = new PostgresUpdatesService({ db,
				storage,
				crypto: new AesCryptoService("a".repeat(64)),
			});
			const stack = await seedStack();
			const created = await service.createUpdate(stack.id, "update");
			await service.startUpdate(created.updateID, {});
			const bigText = `{"version":3,"deployment":{"resources":[],"filler":"${"x".repeat(BLOB_THRESHOLD + 1)}","n":1}}`;
			await service.patchCheckpointVerbatim(created.updateID, {
				version: 3,
				sequenceNumber: 1,
				untypedDeploymentText: bigText,
			});
			const [sidecarBefore] = await db
				.select({ blobKey: checkpoints.blobKey })
				.from(checkpoints)
				.where(
					and(
						eq(checkpoints.updateId, created.updateID),
						eq(checkpoints.version, DELTA_BASE_CHECKPOINT_VERSION),
					),
				);
			if (!sidecarBefore?.blobKey) throw new Error("initial baseline blob key missing");

			const nextText = bigText.replace('"n":1', '"n":2');
			await service.patchCheckpointDelta(created.updateID, {
				version: 3,
				sequenceNumber: 2,
				checkpointHash: hashDeploymentText(nextText),
				deploymentDelta: replaceEdit(bigText, '"n":1', '"n":2'),
			});

			expect(deleteAttempts).toEqual([sidecarBefore.blobKey]);
			expect(await localStorage.exists(sidecarBefore.blobKey)).toBe(true);
			const [sidecarAfter] = await db
				.select({ blobKey: checkpoints.blobKey, data: checkpoints.data })
				.from(checkpoints)
				.where(
					and(
						eq(checkpoints.updateId, created.updateID),
						eq(checkpoints.version, DELTA_BASE_CHECKPOINT_VERSION),
					),
				);
			expect(sidecarAfter?.data).toEqual({ sequenceNumber: 2 });
			expect(sidecarAfter?.blobKey).not.toBe(sidecarBefore.blobKey);
			if (!sidecarAfter?.blobKey) throw new Error("replacement baseline blob key missing");
			expect(await localStorage.exists(sidecarAfter.blobKey)).toBe(true);
			expect(await service.exportStack(stack.id)).toEqual({
				version: 3,
				deployment: JSON.parse(nextText).deployment,
			});
		});

		test("reports bounded storage and operational measurements for repeated large deltas", async () => {
			const deltaCount = 16;
			const loadBlobDir = path.join(blobDir, `delta-load-${Date.now()}`);
			const loadStorage = new LocalBlobStorage(loadBlobDir);
			const loadService = new PostgresUpdatesService({ db,
				storage: loadStorage,
				crypto: new AesCryptoService("a".repeat(64)),
			});
			const stack = await seedStack();
			const created = await loadService.createUpdate(stack.id, "update");
			await loadService.startUpdate(created.updateID, {});

			const filler = "x".repeat(BLOB_THRESHOLD + 64 * 1024);
			let currentText = `{"version":3,"deployment":{"resources":[],"filler":"${filler}","revision":"0000"}}`;
			const memoryStart = process.memoryUsage();
			let peakRssBytes = memoryStart.rss;
			let peakHeapUsedBytes = memoryStart.heapUsed;
			const cpuStart = process.cpuUsage();
			const wallStart = performance.now();

			await loadService.patchCheckpointVerbatim(created.updateID, {
				version: 3,
				sequenceNumber: 1,
				untypedDeploymentText: currentText,
			});

			let blobFilesBeforeDeltas = 0;
			for await (const _ of new Bun.Glob("**/*").scan({ cwd: loadBlobDir, onlyFiles: true })) {
				blobFilesBeforeDeltas++;
			}

			for (let index = 1; index <= deltaCount; index++) {
				const previousRevision = String(index - 1).padStart(4, "0");
				const nextRevision = String(index).padStart(4, "0");
				const nextText = currentText.replace(
					`"revision":"${previousRevision}"`,
					`"revision":"${nextRevision}"`,
				);
				await loadService.patchCheckpointDelta(created.updateID, {
					version: 3,
					sequenceNumber: index + 1,
					checkpointHash: hashDeploymentText(nextText),
					deploymentDelta: replaceEdit(currentText, previousRevision, nextRevision),
				});
				currentText = nextText;
				const memory = process.memoryUsage();
				peakRssBytes = Math.max(peakRssBytes, memory.rss);
				peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
			}

			const wallMs = performance.now() - wallStart;
			const cpu = process.cpuUsage(cpuStart);
			const memoryEnd = process.memoryUsage();
			const rows = await db
				.select({
					version: checkpoints.version,
					isDelta: checkpoints.isDelta,
					data: checkpoints.data,
					blobKey: checkpoints.blobKey,
				})
				.from(checkpoints)
				.where(eq(checkpoints.updateId, created.updateID))
				.orderBy(asc(checkpoints.version));
			const canonicalRows = rows.filter((row) => !row.isDelta);
			const sidecarRows = rows.filter((row) => row.isDelta);

			let blobFilesAfter = 0;
			for await (const _ of new Bun.Glob("**/*").scan({ cwd: loadBlobDir, onlyFiles: true })) {
				blobFilesAfter++;
			}

			expect(rows).toHaveLength(deltaCount + 2);
			expect(canonicalRows).toHaveLength(deltaCount + 1);
			expect(canonicalRows.map((row) => row.version)).toEqual(
				Array.from({ length: deltaCount + 1 }, (_, index) => index + 1),
			);
			expect(canonicalRows.every((row) => row.blobKey !== null && row.data === null)).toBe(true);
			expect(sidecarRows).toHaveLength(1);
			expect(sidecarRows[0]).toMatchObject({
				version: DELTA_BASE_CHECKPOINT_VERSION,
				isDelta: true,
				data: { sequenceNumber: deltaCount + 1 },
			});
			const sidecarBlobKey = sidecarRows[0]?.blobKey;
			if (!sidecarBlobKey) throw new Error("large delta baseline blob key missing");
			expect(sidecarBlobKey).toEndWith(`/base-${deltaCount + 1}`);
			const finalBaseline = await loadStorage.get(sidecarBlobKey);
			if (!finalBaseline) throw new Error("large delta baseline blob missing");
			expect(new TextDecoder().decode(finalBaseline)).toBe(currentText);
			expect(blobFilesBeforeDeltas).toBe(2);
			expect(blobFilesAfter).toBe(deltaCount + 2);

			const exported = await loadService.exportStack(stack.id);
			expect(exported.version).toBe(3);
			const expectedEnvelope: unknown = JSON.parse(currentText);
			if (!expectedEnvelope || typeof expectedEnvelope !== "object" || !("deployment" in expectedEnvelope)) {
				throw new Error("load fixture deployment envelope missing");
			}
			expect(exported.deployment).toEqual(expectedEnvelope.deployment);
			if (!exported.deployment || typeof exported.deployment !== "object" || !("revision" in exported.deployment)) {
				throw new Error("exported load fixture revision missing");
			}
			expect(exported.deployment.revision).toBe(String(deltaCount).padStart(4, "0"));

			process.stdout.write(
				`[delta-checkpoint-load] ${JSON.stringify({
					baselineBytes: Buffer.byteLength(currentText, "utf8"),
					acceptedDeltas: deltaCount,
					wallMs: Number(wallMs.toFixed(2)),
					cpuUserMs: Number((cpu.user / 1000).toFixed(2)),
					cpuSystemMs: Number((cpu.system / 1000).toFixed(2)),
					rssStartBytes: memoryStart.rss,
					rssEndBytes: memoryEnd.rss,
					peakRssBytes,
					heapUsedStartBytes: memoryStart.heapUsed,
					heapUsedEndBytes: memoryEnd.heapUsed,
					peakHeapUsedBytes,
					dbRows: rows.length,
					canonicalRows: canonicalRows.length,
					sidecarRows: sidecarRows.length,
					blobFilesBeforeDeltas,
					blobFilesAfter,
					blobFilesAdded: blobFilesAfter - blobFilesBeforeDeltas,
				})}\n`,
			);
		});
	});
});
