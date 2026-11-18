// @procella/api — stacks tRPC procedures (list, detail, resources, resource).

import { checkpoints, updateEvents, updates } from "@procella/db";
import { deleteManagedEnvironment } from "@procella/esc";
import type { DeploymentV3, ResourceV3 } from "@procella/types";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { adminProcedure, memberProcedure, protectedProcedure, router } from "../trpc.js";

// ============================================================================
// Input Schema
// ============================================================================

const stackInput = z.object({
	org: z.string(),
	project: z.string(),
	stack: z.string(),
});

export const stacksListInputSchema = z
	.object({
		query: z.string().optional(),
		project: z.string().optional(),
		tagName: z.string().optional(),
		tagValue: z.string().optional(),
		continuationToken: z.string().optional(),
		pageSize: z.number().min(1).max(200).default(50).optional(),
		sortBy: z.enum(["name", "lastUpdated", "created"]).default("name").optional(),
		sortOrder: z.enum(["asc", "desc"]).default("asc").optional(),
	})
	.optional();

// ============================================================================
// Helpers
// ============================================================================

/** Extract a human-readable name from a Pulumi URN. */
function nameFromUrn(urn: string): string {
	// URN format: urn:pulumi:stack::project::type::name
	return urn.split("::").pop() ?? urn;
}

/** Extract the provider package from a resource type token. */
function providerFromType(type: string): string {
	// Type format: provider:module:Type (e.g., aws:s3:Bucket)
	const parts = type.split(":");
	return parts[0] ?? type;
}

/** Safely parse a deployment object and extract resources. */
function extractResources(deployment: unknown): ResourceV3[] {
	if (!deployment || typeof deployment !== "object") return [];
	const d = deployment as DeploymentV3;
	return d.resources ?? [];
}

/** Pulumi secret sentinel — objects with this key contain encrypted values. */
const SECRET_SENTINEL = "4dabf18193072939515e22adb298388d";

/** Recursively redact secret values from a property bag. */
function redactSecrets(obj: unknown): unknown {
	if (obj === null || obj === undefined) return obj;
	if (Array.isArray(obj)) return obj.map(redactSecrets);
	if (typeof obj === "object") {
		const record = obj as Record<string, unknown>;
		if (Object.hasOwn(record, SECRET_SENTINEL)) return "[secret]";
		const result: Record<string, unknown> = Object.create(null);
		for (const [k, v] of Object.entries(record)) {
			result[k] = redactSecrets(v);
		}
		return result;
	}
	return obj;
}

// ============================================================================
// Stacks Router
// ============================================================================

export const stacksRouter = router({
	list: protectedProcedure.input(stacksListInputSchema).query(async ({ ctx, input }) => {
		type StackListItem = {
			orgName: string;
			projectName: string;
			stackName: string;
			version: number;
			activeUpdate: boolean;
			currentOperation: string | null;
			tags: Record<string, string>;
		};

		const stackPage =
			input && ctx.stacks.searchStacks
				? await ctx.stacks.searchStacks(ctx.caller.tenantId, {
						query: input.query,
						project: input.project,
						tagName: input.tagName,
						tagValue: input.tagValue,
						continuationToken: input.continuationToken,
						pageSize: input.pageSize,
						sortBy: input.sortBy,
						sortOrder: input.sortOrder,
					})
				: {
						stacks: await ctx.stacks.listStacks(ctx.caller.tenantId, undefined, input?.project),
					};

		const stackList = stackPage.stacks;
		if (stackList.length === 0) {
			return {
				stacks: [] as StackListItem[],
				...(stackPage.continuationToken ? { continuationToken: stackPage.continuationToken } : {}),
			};
		}

		// Batch-fetch max checkpoint version per stack
		const stackIds = stackList.map((s) => s.id);
		const versionRows = await ctx.db
			.select({
				stackId: checkpoints.stackId,
				maxVersion: max(checkpoints.version),
			})
			.from(checkpoints)
			.where(sql`${checkpoints.stackId} IN ${stackIds}`)
			.groupBy(checkpoints.stackId);

		const versionMap = new Map(versionRows.map((r) => [r.stackId, Number(r.maxVersion ?? 0)]));

		// Batch-fetch active update kind per stack (stacks with non-null activeUpdateId)
		const activeStackIds = stackList
			.filter((s) => s.activeUpdateId !== null)
			.map((s) => s.activeUpdateId as string);

		const operationMap = new Map<string, string>();
		if (activeStackIds.length > 0) {
			const activeRows = await ctx.db
				.select({
					id: updates.id,
					kind: updates.kind,
				})
				.from(updates)
				.where(sql`${updates.id} IN ${activeStackIds}`);

			for (const row of activeRows) {
				operationMap.set(row.id, row.kind);
			}
		}

		const mapped: StackListItem[] = stackList.map((s) => ({
			orgName: ctx.caller.orgSlug,
			projectName: s.projectName,
			stackName: s.stackName,
			version: versionMap.get(s.id) ?? 0,
			activeUpdate: s.activeUpdateId !== null,
			currentOperation: s.activeUpdateId ? (operationMap.get(s.activeUpdateId) ?? null) : null,
			tags: s.tags,
		}));

		return {
			stacks: mapped,
			...(stackPage.continuationToken ? { continuationToken: stackPage.continuationToken } : {}),
		};
	}),

	detail: protectedProcedure.input(stackInput).query(async ({ ctx, input }) => {
		const stackInfo = await ctx.stacks.getStack(
			ctx.caller.tenantId,
			input.org,
			input.project,
			input.stack,
		);

		// Get max checkpoint version
		const [versionRow] = await ctx.db
			.select({ maxVersion: max(checkpoints.version) })
			.from(checkpoints)
			.where(eq(checkpoints.stackId, stackInfo.id));

		const version = Number(versionRow?.maxVersion ?? 0);

		// Get active update operation kind (if running)
		let currentOperation: string | null = null;
		if (stackInfo.activeUpdateId) {
			const [activeRow] = await ctx.db
				.select({ kind: updates.kind })
				.from(updates)
				.where(eq(updates.id, stackInfo.activeUpdateId))
				.limit(1);
			currentOperation = activeRow?.kind ?? null;
		}

		// Get latest update info
		const [latestUpdate] = await ctx.db
			.select()
			.from(updates)
			.where(eq(updates.stackId, stackInfo.id))
			.orderBy(desc(updates.createdAt))
			.limit(1);

		// Get resource changes from latest update's summary event
		let lastResourceChanges: Record<string, number> = {};
		if (latestUpdate) {
			const [summaryRow] = await ctx.db
				.select({ fields: updateEvents.fields })
				.from(updateEvents)
				.where(and(eq(updateEvents.updateId, latestUpdate.id), eq(updateEvents.kind, "summary")))
				.orderBy(desc(updateEvents.sequence))
				.limit(1);

			if (summaryRow?.fields) {
				const fields = summaryRow.fields as {
					summaryEvent?: { resourceChanges?: Record<string, number> };
				};
				lastResourceChanges = fields.summaryEvent?.resourceChanges ?? {};
			}
		}

		return {
			orgName: stackInfo.orgName,
			projectName: stackInfo.projectName,
			stackName: stackInfo.stackName,
			version,

			tags: stackInfo.tags,
			activeUpdate: stackInfo.activeUpdateId !== null,
			currentOperation,
			lastUpdate: latestUpdate
				? {
						updateID: latestUpdate.id,
						kind: latestUpdate.kind,
						result: latestUpdate.result ?? "",
						message: latestUpdate.message ?? "",
						startTime: latestUpdate.startedAt
							? Math.floor(latestUpdate.startedAt.getTime() / 1000)
							: 0,
						endTime: latestUpdate.completedAt
							? Math.floor(latestUpdate.completedAt.getTime() / 1000)
							: 0,
						resourceChanges: lastResourceChanges,
					}
				: null,
		};
	}),

	updateTags: memberProcedure
		.input(stackInput.extend({ tags: z.record(z.string(), z.string()) }))
		.mutation(async ({ ctx, input }) => {
			await ctx.stacks.replaceStackTags(
				ctx.caller.tenantId,
				input.org,
				input.project,
				input.stack,
				input.tags,
			);
		}),

	rename: memberProcedure
		.input(stackInput.extend({ newStack: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await ctx.stacks.renameStack(
				ctx.caller.tenantId,
				input.org,
				input.project,
				input.stack,
				input.newStack,
			);
		}),

	delete: adminProcedure
		.input(stackInput.extend({ force: z.boolean().optional() }))
		.mutation(async ({ ctx, input }) => {
			// The managed environment is deleted in the stack's deletion transaction.
			await ctx.stacks.deleteStack(
				ctx.caller.tenantId,
				input.org,
				input.project,
				input.stack,
				input.force,
				{
					withinTransaction: async (tx, { managedEnvironment }) => {
						if (managedEnvironment) {
							await deleteManagedEnvironment(ctx.esc, ctx.caller.tenantId, managedEnvironment, {
								tx,
							});
						}
					},
				},
			);
		}),

	export: protectedProcedure.input(stackInput).query(async ({ ctx, input }) => {
		const stackInfo = await ctx.stacks.getStack(
			ctx.caller.tenantId,
			input.org,
			input.project,
			input.stack,
		);
		return ctx.updates.exportStack(stackInfo.id);
	}),

	import: memberProcedure
		.input(stackInput.extend({ deployment: z.record(z.string(), z.unknown()) }))
		.mutation(async ({ ctx, input }) => {
			const stackInfo = await ctx.stacks.getStack(
				ctx.caller.tenantId,
				input.org,
				input.project,
				input.stack,
			);
			return ctx.updates.importStack(stackInfo.id, input.deployment);
		}),

	repair: memberProcedure.input(stackInput).mutation(async ({ ctx, input }) => {
		const stackInfo = await ctx.stacks.getStack(
			ctx.caller.tenantId,
			input.org,
			input.project,
			input.stack,
		);

		const mutations = await ctx.updates.repairStack(stackInfo.id);
		return { mutations, mutationCount: mutations.length };
	}),

	resources: protectedProcedure.input(stackInput).query(async ({ ctx, input }) => {
		const stackInfo = await ctx.stacks.getStack(
			ctx.caller.tenantId,
			input.org,
			input.project,
			input.stack,
		);

		const deployment = await ctx.updates.exportStack(stackInfo.id);

		const resources = extractResources(deployment.deployment);

		// Return sanitized resources — NO inputs/outputs to avoid leaking secrets
		return resources
			.filter((r) => r.type !== "pulumi:pulumi:Stack") // Exclude root stack resource
			.map((r) => ({
				urn: r.urn,
				type: r.type,
				name: nameFromUrn(r.urn),
				provider: providerFromType(r.type),
				parent: r.parent ? nameFromUrn(r.parent) : null,
				custom: r.custom,
				id: r.id ?? null,
				protect: r.protect ?? false,
				external: r.external ?? false,
				dependencies: (r.dependencies ?? []).length,
			}));
	}),

	resource: protectedProcedure
		.input(stackInput.extend({ urn: z.string() }))
		.query(async ({ ctx, input }) => {
			const stackInfo = await ctx.stacks.getStack(
				ctx.caller.tenantId,
				input.org,
				input.project,
				input.stack,
			);

			const deployment = await ctx.updates.exportStack(stackInfo.id);

			const resources = extractResources(deployment.deployment);

			// Build indexes for O(1) lookups
			const byUrn = new Map(resources.map((r) => [r.urn, r]));
			const resource = byUrn.get(input.urn);
			if (!resource) return null;

			// Find children (resources whose parent is this URN)
			const children = resources
				.filter((r) => r.parent === resource.urn)
				.map((r) => ({ urn: r.urn, type: r.type, name: nameFromUrn(r.urn) }));

			// Resolve dependency URNs to names via index
			const dependencyDetails = (resource.dependencies ?? []).map((depUrn) => {
				const dep = byUrn.get(depUrn);
				return {
					urn: depUrn,
					type: dep?.type ?? "unknown",
					name: nameFromUrn(depUrn),
				};
			});

			return {
				urn: resource.urn,
				type: resource.type,
				name: nameFromUrn(resource.urn),
				provider: providerFromType(resource.type),
				id: resource.id ?? null,
				custom: resource.custom,
				protect: resource.protect ?? false,
				external: resource.external ?? false,
				parent: resource.parent
					? { urn: resource.parent, name: nameFromUrn(resource.parent) }
					: null,
				children,
				dependencies: dependencyDetails,
				outputs: redactSecrets(resource.outputs ?? {}) as Record<string, unknown>,
				inputs: redactSecrets(resource.inputs ?? {}) as Record<string, unknown>,
				created: resource.created ?? null,
				modified: resource.modified ?? null,
				aliases: resource.aliases ?? [],
				initErrors: resource.initErrors ?? [],
				taint: resource.taint ?? false,
				pendingReplacement: resource.pendingReplacement ?? false,
				delete: resource.delete ?? false,
				retainOnDelete: resource.retainOnDelete ?? false,
			};
		}),
});
