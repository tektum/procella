import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { AesCryptoService } from "@procella/crypto";
import { checkpoints, type Database, journalEntries } from "@procella/db";
import { PostgresStacksService, type StackInfo } from "@procella/stacks";
import { LocalBlobStorage } from "@procella/storage";
import {
	BadRequestError,
	JournalEntryBegin,
	JournalEntrySuccess,
	LeaseExpiredError,
	UpdateConflictError,
	UpdateNotFoundError,
} from "@procella/types";
import { ImportConflictError, PostgresUpdatesService } from "@procella/updates";
import { asc, eq } from "drizzle-orm";
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
});
