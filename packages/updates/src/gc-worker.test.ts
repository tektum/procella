import { describe, expect, test } from "bun:test";
import { GCWorker } from "./gc-worker.js";

describe("@procella/updates GCWorker", () => {
	// ========================================================================
	// Resilience
	// ========================================================================

	describe("resilience", () => {
		test("start does not throw when db.execute rejects", async () => {
			const failDb = {
				execute: () => Promise.reject(new Error("connection refused")),
			};
			const worker = new GCWorker({ db: failDb as never, interval: 60_000 });
			expect(await worker.start()).toBeUndefined();
			await worker.stop();
		});
	});

	// ========================================================================
	// M8: Grace window
	// ========================================================================

	describe("M8: grace window excludes recently-expired leases", () => {
		test("functional: runOnce completes the GC cycle without throwing (PR #149 review — invoke the actual cycle, not just constants)", async () => {
			const mockDb = {
				execute: async (query: unknown) => {
					const queryStr = String(query);
					if (queryStr.includes("pg_try_advisory_lock")) {
						return { rows: [{ acquired: true }] };
					}
					return { rows: [] };
				},
				select: () => ({
					from: () => ({
						where: () => Promise.resolve([]),
					}),
				}),
				update: () => ({
					set: () => ({
						where: () => ({ returning: () => [] }),
					}),
				}),
			};

			const worker = new GCWorker({ db: mockDb as never, interval: 60_000 });
			await expect(worker.runOnce()).resolves.toBeUndefined();
		});
	});
});
