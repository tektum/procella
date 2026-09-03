// @procella/api — updates.list + updates.latest tRPC procedures.

import type { Database } from "@procella/db";
import { updateEvents, updates } from "@procella/db";

import { TRPCError, tracked } from "@trpc/server";
import { and, asc, desc, eq, gt, inArray, ne } from "drizzle-orm";
import { Client } from "pg";
import { z } from "zod/v4";
import { protectedProcedure, router } from "../trpc.js";

// ============================================================================
// Input Schema
// ============================================================================

const stackInput = z.object({
	org: z.string(),
	project: z.string(),
	stack: z.string(),
});

// ============================================================================
// Helpers
// ============================================================================

/** Extract resourceChanges from a summary event's fields. */
function parseResourceChanges(fields: unknown): Record<string, number> {
	if (!fields || typeof fields !== "object") return {};
	const f = fields as { summaryEvent?: { resourceChanges?: Record<string, number> } };
	return f.summaryEvent?.resourceChanges ?? {};
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveUpdateId(
	db: Database,
	stackId: string,
	updateIdOrVersion: string,
): Promise<string> {
	if (UUID_RE.test(updateIdOrVersion)) {
		const [row] = await db
			.select({ id: updates.id })
			.from(updates)
			.where(and(eq(updates.stackId, stackId), eq(updates.id, updateIdOrVersion)))
			.limit(1);
		if (!row) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Update not found" });
		}
		return row.id;
	}

	const version = Number(updateIdOrVersion);
	if (!Number.isInteger(version) || version <= 0) {
		throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid update identifier" });
	}

	const [row] = await db
		.select({ id: updates.id })
		.from(updates)
		.where(
			and(
				eq(updates.stackId, stackId),
				eq(updates.version, version),
				// Pulumi preview permalinks use the opaque update ID; numeric permalinks are updates.
				ne(updates.kind, "preview"),
			),
		)
		.orderBy(desc(updates.createdAt))
		.limit(1);

	if (!row) {
		throw new TRPCError({ code: "NOT_FOUND", message: `Update version ${version} not found` });
	}
	return row.id;
}

// ============================================================================
// Updates Router
// ============================================================================

export const updatesRouter = router({
	list: protectedProcedure.input(stackInput).query(async ({ ctx, input }) => {
		// Resolve stack to verify access and get stackId
		const stackInfo = await ctx.stacks.getStack(
			ctx.caller.tenantId,
			input.org,
			input.project,
			input.stack,
		);

		// Query updates directly for dashboard-specific fields
		const rows = await ctx.db
			.select()
			.from(updates)
			.where(eq(updates.stackId, stackInfo.id))
			.orderBy(desc(updates.createdAt));

		if (rows.length === 0) return [];

		// Batch-fetch summary events for all updates to populate resourceChanges
		const updateIds = rows.map((r) => r.id);
		const summaryRows = await ctx.db
			.select({
				updateId: updateEvents.updateId,
				fields: updateEvents.fields,
				sequence: updateEvents.sequence,
			})
			.from(updateEvents)
			.where(and(inArray(updateEvents.updateId, updateIds), eq(updateEvents.kind, "summary")))
			.orderBy(desc(updateEvents.sequence));

		// Keep only the latest (highest sequence) summary per update
		const resourceChangesMap = new Map<string, Record<string, number>>();
		for (const row of summaryRows) {
			if (!resourceChangesMap.has(row.updateId)) {
				resourceChangesMap.set(row.updateId, parseResourceChanges(row.fields));
			}
		}

		return rows.map((row) => ({
			updateID: row.id,
			kind: row.kind,
			result: row.result ?? "",
			version: row.version,
			message: row.message ?? "",
			startTime: row.startedAt ? Math.floor(row.startedAt.getTime() / 1000) : 0,
			endTime: row.completedAt ? Math.floor(row.completedAt.getTime() / 1000) : 0,
			resourceChanges: resourceChangesMap.get(row.id) ?? {},
			initiatedBy: row.initiatedBy ?? null,
			initiatedByType: row.initiatedByType ?? null,
			initiatedByDisplay: row.initiatedByDisplay ?? null,
		}));
	}),

	latest: protectedProcedure.input(stackInput).query(async ({ ctx, input }) => {
		const stackInfo = await ctx.stacks.getStack(
			ctx.caller.tenantId,
			input.org,
			input.project,
			input.stack,
		);

		const [row] = await ctx.db
			.select()
			.from(updates)
			.where(eq(updates.stackId, stackInfo.id))
			.orderBy(desc(updates.createdAt))
			.limit(1);

		if (!row) {
			return null;
		}

		// Fetch summary event for this update
		const [summaryRow] = await ctx.db
			.select({ fields: updateEvents.fields })
			.from(updateEvents)
			.where(and(eq(updateEvents.updateId, row.id), eq(updateEvents.kind, "summary")))
			.orderBy(desc(updateEvents.sequence))
			.limit(1);

		return {
			updateID: row.id,
			kind: row.kind,
			result: row.result ?? "",
			version: row.version,
			message: row.message ?? "",
			startTime: row.startedAt ? Math.floor(row.startedAt.getTime() / 1000) : 0,
			endTime: row.completedAt ? Math.floor(row.completedAt.getTime() / 1000) : 0,
			resourceChanges: summaryRow ? parseResourceChanges(summaryRow.fields) : {},
		};
	}),

	get: protectedProcedure
		.input(
			z.object({
				org: z.string(),
				project: z.string(),
				stack: z.string(),
				updateIdOrVersion: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const stackInfo = await ctx.stacks.getStack(
				ctx.caller.tenantId,
				input.org,
				input.project,
				input.stack,
			);

			const updateId = await resolveUpdateId(ctx.db, stackInfo.id, input.updateIdOrVersion);

			const [row] = await ctx.db
				.select()
				.from(updates)
				.where(and(eq(updates.id, updateId), eq(updates.stackId, stackInfo.id)))
				.limit(1);

			if (!row) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Update not found" });
			}

			const [summaryRow] = await ctx.db
				.select({ fields: updateEvents.fields })
				.from(updateEvents)
				.where(and(eq(updateEvents.updateId, row.id), eq(updateEvents.kind, "summary")))
				.orderBy(desc(updateEvents.sequence))
				.limit(1);

			return {
				updateID: row.id,
				kind: row.kind,
				result: row.result ?? "",
				version: row.version,
				message: row.message ?? "",
				startTime: row.startedAt ? Math.floor(row.startedAt.getTime() / 1000) : 0,
				endTime: row.completedAt ? Math.floor(row.completedAt.getTime() / 1000) : 0,
				resourceChanges: summaryRow ? parseResourceChanges(summaryRow.fields) : {},
			};
		}),

	onEvents: protectedProcedure
		.input(
			z.object({
				org: z.string(),
				project: z.string(),
				stack: z.string(),
				updateId: z.string(),
				lastEventId: z.coerce.number().nullish(),
			}),
		)
		.subscription(async function* (opts) {
			const { org, project, stack, updateId: rawUpdateId, lastEventId } = opts.input;

			const stackInfo = await opts.ctx.stacks.getStack(
				opts.ctx.caller.tenantId,
				org,
				project,
				stack,
			);
			const updateId = await resolveUpdateId(opts.ctx.db, stackInfo.id, rawUpdateId);

			let lastSeq = lastEventId ?? 0;

			const pg = new Client({ connectionString: opts.ctx.dbUrl });
			await pg.connect();
			await pg.query("LISTEN update_events");

			const notify = new EventTarget();
			pg.on("notification", (msg) => {
				if (msg.payload === updateId) notify.dispatchEvent(new Event("ping"));
			});
			pg.on("error", (err) => {
				notify.dispatchEvent(new CustomEvent("dberror", { detail: err }));
			});

			try {
				const replay = await opts.ctx.db
					.select({ sequence: updateEvents.sequence, fields: updateEvents.fields })
					.from(updateEvents)
					.where(and(eq(updateEvents.updateId, updateId), gt(updateEvents.sequence, lastSeq)))
					.orderBy(asc(updateEvents.sequence));

				for (const row of replay) {
					lastSeq = row.sequence;
					yield tracked(String(row.sequence), row.fields as Record<string, unknown>);
				}

				const signal = opts.signal ?? AbortSignal.timeout(3_600_000);
				while (!signal.aborted) {
					await new Promise<void>((resolve, reject) => {
						const done = () => {
							notify.removeEventListener("ping", done);
							notify.removeEventListener("dberror", onErr);
							signal.removeEventListener("abort", abort);
							resolve();
						};
						const abort = () => {
							notify.removeEventListener("ping", done);
							notify.removeEventListener("dberror", onErr);
							signal.removeEventListener("abort", abort);
							reject(new DOMException("Aborted", "AbortError"));
						};
						const onErr = (e: Event) => {
							notify.removeEventListener("ping", done);
							notify.removeEventListener("dberror", onErr);
							signal.removeEventListener("abort", abort);
							reject((e as CustomEvent).detail ?? new Error("DB connection error"));
						};
						notify.addEventListener("ping", done, { once: true });
						notify.addEventListener("dberror", onErr, { once: true });
						signal.addEventListener("abort", abort, { once: true });
					});

					const newRows = await opts.ctx.db
						.select({ sequence: updateEvents.sequence, fields: updateEvents.fields })
						.from(updateEvents)
						.where(and(eq(updateEvents.updateId, updateId), gt(updateEvents.sequence, lastSeq)))
						.orderBy(asc(updateEvents.sequence));

					for (const row of newRows) {
						lastSeq = row.sequence;
						yield tracked(String(row.sequence), row.fields as Record<string, unknown>);
					}
				}
			} catch (e) {
				if (e instanceof DOMException && e.name === "AbortError") return;
				throw e;
			} finally {
				await pg.end().catch(() => {});
			}
		}),

	onStackActivity: protectedProcedure.input(stackInput).subscription(async function* (opts) {
		const { org, project, stack } = opts.input;

		const stackInfo = await opts.ctx.stacks.getStack(opts.ctx.caller.tenantId, org, project, stack);

		const pg = new Client({ connectionString: opts.ctx.dbUrl });
		await pg.connect();
		await pg.query("LISTEN stack_updates");

		const notify = new EventTarget();
		pg.on("notification", (msg) => {
			if (msg.payload === stackInfo.id) notify.dispatchEvent(new Event("ping"));
		});
		pg.on("error", (err) => {
			notify.dispatchEvent(new CustomEvent("dberror", { detail: err }));
		});

		try {
			const signal = opts.signal ?? AbortSignal.timeout(3_600_000);
			while (!signal.aborted) {
				await new Promise<void>((resolve, reject) => {
					const done = () => {
						notify.removeEventListener("ping", done);
						notify.removeEventListener("dberror", onErr);
						signal.removeEventListener("abort", abort);
						resolve();
					};
					const abort = () => {
						notify.removeEventListener("ping", done);
						notify.removeEventListener("dberror", onErr);
						signal.removeEventListener("abort", abort);
						reject(new DOMException("Aborted", "AbortError"));
					};
					const onErr = (e: Event) => {
						notify.removeEventListener("ping", done);
						notify.removeEventListener("dberror", onErr);
						signal.removeEventListener("abort", abort);
						reject((e as CustomEvent).detail ?? new Error("DB connection error"));
					};
					notify.addEventListener("ping", done, { once: true });
					notify.addEventListener("dberror", onErr, { once: true });
					signal.addEventListener("abort", abort, { once: true });
				});

				// Fetch the most recently changed update for this stack
				const [row] = await opts.ctx.db
					.select()
					.from(updates)
					.where(eq(updates.stackId, stackInfo.id))
					.orderBy(desc(updates.updatedAt))
					.limit(1);

				if (row) {
					// Fetch summary event for resource changes
					const [summaryRow] = await opts.ctx.db
						.select({ fields: updateEvents.fields })
						.from(updateEvents)
						.where(and(eq(updateEvents.updateId, row.id), eq(updateEvents.kind, "summary")))
						.orderBy(desc(updateEvents.sequence))
						.limit(1);

					yield tracked(row.id, {
						updateID: row.id,
						kind: row.kind,
						result: row.result ?? "",
						version: row.version,
						message: row.message ?? "",
						startTime: row.startedAt ? Math.floor(row.startedAt.getTime() / 1000) : 0,
						endTime: row.completedAt ? Math.floor(row.completedAt.getTime() / 1000) : 0,
						resourceChanges: summaryRow ? parseResourceChanges(summaryRow.fields) : {},
					});
				}
			}
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") return;
			throw e;
		} finally {
			await pg.end().catch(() => {});
		}
	}),
});
