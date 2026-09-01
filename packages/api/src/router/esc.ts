// @procella/api — ESC tRPC procedures (read-only queries for the dashboard).
// Mutations go through REST /api/esc/* for `esc` CLI compatibility.

import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { protectedProcedure, router } from "../trpc.js";

const projectInput = z.object({
	project: z.string().min(1),
});

const environmentInput = projectInput.extend({
	environment: z.string().min(1),
});

const revisionInput = environmentInput.extend({
	revision: z.number().int().min(1),
});

const draftInput = environmentInput.extend({
	draftId: z.string().uuid(),
});

const draftStatusFilter = environmentInput.extend({
	status: z.enum(["open", "applied", "discarded"]).optional(),
});

const UNKNOWN_USER = "Unknown user";
const MAX_CONCURRENT_IDENTITY_LOOKUPS = 8;

type UserDisplayNameResolver = (subject: string) => Promise<string | null>;

async function resolveCreatedBy<T extends { createdBy: string }>(
	resolveUserDisplayName: UserDisplayNameResolver,
	value: T,
): Promise<T> {
	const createdBy =
		(await resolveUserDisplayName(value.createdBy).catch(() => null)) ?? UNKNOWN_USER;
	return { ...value, createdBy };
}

async function resolveCreatedByList<T extends { createdBy: string }>(
	resolveUserDisplayName: UserDisplayNameResolver,
	values: T[],
): Promise<T[]> {
	const subjects = [...new Set(values.map((value) => value.createdBy))];
	const displayNames = new Map<string, string>();
	let nextSubject = 0;
	const worker = async () => {
		while (nextSubject < subjects.length) {
			const subject = subjects[nextSubject++];
			if (subject === undefined) return;
			const displayName = (await resolveUserDisplayName(subject).catch(() => null)) ?? UNKNOWN_USER;
			displayNames.set(subject, displayName);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(MAX_CONCURRENT_IDENTITY_LOOKUPS, subjects.length) }, worker),
	);
	return values.map((value) => ({
		...value,
		createdBy: displayNames.get(value.createdBy) ?? UNKNOWN_USER,
	}));
}

export const escRouter = router({
	listProjects: protectedProcedure.query(async ({ ctx }) => {
		return ctx.esc.listProjects(ctx.caller.tenantId);
	}),

	listEnvironments: protectedProcedure.input(projectInput).query(async ({ ctx, input }) => {
		const environments = await ctx.esc.listEnvironments(ctx.caller.tenantId, input.project);
		return resolveCreatedByList(ctx.resolveUserDisplayName, environments);
	}),

	getEnvironment: protectedProcedure.input(environmentInput).query(async ({ ctx, input }) => {
		const env = await ctx.esc.getEnvironment(ctx.caller.tenantId, input.project, input.environment);
		if (!env) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `Environment ${input.project}/${input.environment} not found`,
			});
		}
		return resolveCreatedBy(ctx.resolveUserDisplayName, env);
	}),

	listRevisions: protectedProcedure.input(environmentInput).query(async ({ ctx, input }) => {
		const revisions = await ctx.esc.listRevisions(
			ctx.caller.tenantId,
			input.project,
			input.environment,
		);
		return resolveCreatedByList(ctx.resolveUserDisplayName, revisions);
	}),

	getRevision: protectedProcedure.input(revisionInput).query(async ({ ctx, input }) => {
		const rev = await ctx.esc.getRevision(
			ctx.caller.tenantId,
			input.project,
			input.environment,
			input.revision,
		);
		if (!rev) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `Revision ${input.project}/${input.environment}#${input.revision} not found`,
			});
		}
		return resolveCreatedBy(ctx.resolveUserDisplayName, rev);
	}),

	listRevisionTags: protectedProcedure.input(environmentInput).query(async ({ ctx, input }) => {
		const tags = await ctx.esc.listRevisionTags(
			ctx.caller.tenantId,
			input.project,
			input.environment,
		);
		return resolveCreatedByList(ctx.resolveUserDisplayName, tags);
	}),

	getEnvironmentTags: protectedProcedure.input(environmentInput).query(async ({ ctx, input }) => {
		return ctx.esc.getEnvironmentTags(ctx.caller.tenantId, input.project, input.environment);
	}),

	listDrafts: protectedProcedure.input(draftStatusFilter).query(async ({ ctx, input }) => {
		const drafts = await ctx.esc.listDrafts(
			ctx.caller.tenantId,
			input.project,
			input.environment,
			input.status,
		);
		return resolveCreatedByList(ctx.resolveUserDisplayName, drafts);
	}),

	getDraft: protectedProcedure.input(draftInput).query(async ({ ctx, input }) => {
		const draft = await ctx.esc.getDraft(
			ctx.caller.tenantId,
			input.project,
			input.environment,
			input.draftId,
		);
		if (!draft) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `Draft ${input.draftId} not found`,
			});
		}
		return resolveCreatedBy(ctx.resolveUserDisplayName, draft);
	}),
});
