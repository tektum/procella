// @procella/updates — GC Worker for cleaning up stale/orphaned updates.

import type { Database } from "@procella/db";
import { githubUpdateOutbox, stacks, updates } from "@procella/db";
import { activeUpdatesGauge, gcCycleCount, gcOrphansCleanedCount } from "@procella/telemetry";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import {
	GC_ADVISORY_LOCK_ID,
	GC_INTERVAL_MS,
	GC_LEASE_GRACE_MS,
	GC_STALE_THRESHOLD_MS,
} from "./types.js";

// ============================================================================
// GCWorker
// ============================================================================

export class GCWorker {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private readonly db: Database;
	private readonly interval: number;

	constructor({ db, interval }: { db: Database; interval?: number }) {
		this.db = db;
		this.interval = interval ?? GC_INTERVAL_MS;
	}

	async start(): Promise<void> {
		await this.runCycle();
		this.timer = setInterval(() => this.runCycle(), this.interval);
	}

	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		// Wait for in-flight cycle to finish
		while (this.running) {
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	/** Run a single GC cycle (for use by cron endpoints). */
	async runOnce(): Promise<void> {
		await this.runCycle();
	}

	private async runCycle(): Promise<void> {
		if (this.running) return;
		this.running = true;
		gcCycleCount().add(1);

		try {
			const result = await this.db.transaction(async (tx) => {
				const lockResult = await tx.execute(
					sql`SELECT pg_try_advisory_xact_lock(${GC_ADVISORY_LOCK_ID}) as acquired`,
				);
				const rows = "rows" in lockResult ? lockResult.rows : lockResult;
				const first = rows[0];
				if (
					!first ||
					typeof first !== "object" ||
					!("acquired" in first) ||
					first.acquired !== true
				) {
					return null;
				}

				const now = new Date();
				const graceThreshold = new Date(now.getTime() - GC_LEASE_GRACE_MS);
				const expiredLeaseUpdates = await tx
					.update(updates)
					.set({
						status: "cancelled",
						leaseToken: null,
						leaseExpiresAt: null,
						completedAt: sql`now()`,
						updatedAt: sql`now()`,
					})
					.where(and(eq(updates.status, "running"), lt(updates.leaseExpiresAt, graceThreshold)))
					.returning({
						id: updates.id,
						stackId: updates.stackId,
						githubTarget: updates.githubTarget,
					});

				const staleThreshold = new Date(now.getTime() - GC_STALE_THRESHOLD_MS);
				const staleUpdates = await tx
					.update(updates)
					.set({
						status: "cancelled",
						leaseToken: null,
						leaseExpiresAt: null,
						completedAt: sql`now()`,
						updatedAt: sql`now()`,
					})
					.where(
						and(
							inArray(updates.status, ["not started", "requested"]),
							lt(updates.createdAt, staleThreshold),
						),
					)
					.returning({ id: updates.id, stackId: updates.stackId });

				const allOrphans = [...expiredLeaseUpdates, ...staleUpdates];
				if (allOrphans.length > 0) {
					const orphanIds = allOrphans.map((update) => update.id);

					const publishable = expiredLeaseUpdates.filter((update) => update.githubTarget);
					if (publishable.length > 0) {
						await tx
							.insert(githubUpdateOutbox)
							.values(
								publishable.map((update) => ({
									updateId: update.id,
									phase: "terminal" as const,
								})),
							)
							.onConflictDoNothing();
					}

					const affectedStackIds = [...new Set(allOrphans.map((update) => update.stackId))];
					await tx
						.update(stacks)
						.set({ activeUpdateId: null, updatedAt: sql`now()` })
						.where(
							and(inArray(stacks.id, affectedStackIds), inArray(stacks.activeUpdateId, orphanIds)),
						);
				}

				return {
					orphanCount: allOrphans.length,
					expiredRunningCount: expiredLeaseUpdates.length,
				};
			});

			if (!result) return;
			if (result.expiredRunningCount > 0) {
				activeUpdatesGauge().add(-result.expiredRunningCount);
			}
			gcOrphansCleanedCount().add(result.orphanCount);
		} catch (err) {
			// GC is best-effort — log and retry on next interval. Never crash the server.
			console.error("[gc] cycle failed:", err);
		} finally {
			this.running = false;
		}
	}
}
