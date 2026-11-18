// @procella/server — Stack CRUD handlers.

import {
	deleteManagedEnvironment,
	type EscService,
	MANAGED_ENVIRONMENT_PLACEHOLDER,
} from "@procella/esc";
import type { StackInfo, StacksService } from "@procella/stacks";
import type { Stack, StackRenameRequest, StackSummary } from "@procella/types";
import { BadRequestError } from "@procella/types";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param } from "./params.js";

// ============================================================================
// Stack Handlers
// ============================================================================

export function stackHandlers(stacks: StacksService, esc?: EscService) {
	return {
		/** POST /api/stacks/:org/:project/:stack OR POST /api/stacks/:org/:project (stack in body) */
		createStack: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const body = await c.req.json().catch(() => ({}));
			const typedBody = body as {
				stackName?: string;
				tags?: Record<string, string>;
				createManagedEnvironment?: boolean;
			};
			// Stack name can come from URL param or request body
			const stack = c.req.param("stack") ?? typedBody.stackName ?? "";
			if (!stack) {
				throw new BadRequestError("Missing stack name in URL or body");
			}
			if (typedBody.createManagedEnvironment !== true) {
				const result = await stacks.createStack(
					caller.tenantId,
					org,
					project,
					stack,
					typedBody.tags,
				);
				return c.json(mapToStack(result, caller.orgSlug));
			}

			if (!esc) {
				throw new BadRequestError("ESC-managed environments are not supported by this server");
			}
			// The stack manages ESC environment <project>/<stack>. Both are created in one
			// transaction: if the environment cannot be created (e.g. it already exists, 409),
			// no stack row is committed.
			const result = await stacks.createStack(
				caller.tenantId,
				org,
				project,
				stack,
				typedBody.tags,
				{
					managedEnvironment: {
						name: `${project}/${stack}`,
						create: (tx) =>
							esc.createEnvironment(
								caller.tenantId,
								{ projectName: project, name: stack, yamlBody: MANAGED_ENVIRONMENT_PLACEHOLDER },
								caller.userId,
								{ tx },
							),
					},
				},
			);
			return c.json(mapToStack(result, caller.orgSlug));
		},

		getStack: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const result = await stacks.getStack(caller.tenantId, org, project, stack);
			return c.json(mapToStack(result, caller.orgSlug));
		},

		deleteStack: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const force = c.req.query("force") === "true";
			// A managed stack's environment is deleted in the stack's deletion transaction, using
			// the locked row's metadata, so only the environment this stack owns is removed.
			await stacks.deleteStack(caller.tenantId, org, project, stack, force, {
				withinTransaction: async (tx, owned) => {
					if (esc) {
						await deleteManagedEnvironment(esc, caller.tenantId, owned, { tx });
					}
				},
			});
			return c.body(null, 204);
		},

		listStacks: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = c.req.query("organization");
			const project = c.req.query("project");
			const tagName = c.req.query("tagName");
			const tagValue = c.req.query("tagValue");
			const query = c.req.query("query");
			const continuationToken = c.req.query("continuationToken");
			const pageSize = c.req.query("pageSize");
			const sortBy = c.req.query("sortBy");
			const sortOrder = c.req.query("sortOrder");

			const hasSearchParams = Boolean(
				tagName || tagValue || query || continuationToken || pageSize || sortBy || sortOrder,
			);
			if (!hasSearchParams) {
				const results = await stacks.listStacks(caller.tenantId, org, project);
				return c.json({ stacks: results.map((r) => mapToStackSummary(r, caller.orgSlug)) });
			}

			if (!stacks.searchStacks) {
				const results = await stacks.listStacks(caller.tenantId, org, project);
				return c.json({ stacks: results.map((r) => mapToStackSummary(r, caller.orgSlug)) });
			}

			const page = await stacks.searchStacks(caller.tenantId, {
				organization: org,
				project,
				tagName,
				tagValue,
				query,
				continuationToken,
				pageSize: pageSize && !Number.isNaN(Number(pageSize)) ? Number(pageSize) : undefined,
				sortBy:
					sortBy === "name" || sortBy === "lastUpdated" || sortBy === "created"
						? sortBy
						: undefined,
				sortOrder: sortOrder === "asc" || sortOrder === "desc" ? sortOrder : undefined,
			});

			return c.json({
				stacks: page.stacks.map((r) => mapToStackSummary(r, caller.orgSlug)),
				...(page.continuationToken ? { continuationToken: page.continuationToken } : {}),
			});
		},

		renameStack: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const body = await c.req.json<StackRenameRequest>();
			await stacks.renameStack(caller.tenantId, org, project, stack, body.newName);
			return c.body(null, 204);
		},

		updateStackTags: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const tags = await c.req.json<Record<string, string>>();
			await stacks.updateStackTags(caller.tenantId, org, project, stack, tags);
			return c.body(null, 204);
		},
	};
}

// ============================================================================
// Helpers
// ============================================================================

function mapToStack(info: StackInfo, orgSlug?: string): Stack {
	return {
		id: info.id,
		orgName: orgSlug ?? info.orgName,
		projectName: info.projectName,
		stackName: info.stackName,
		tags: info.tags,
		activeUpdate: info.activeUpdateId ?? "",
		...(info.managedEnvironment ? { managedEnvironment: info.managedEnvironment } : {}),
		version: 0,
	} as Stack;
}

function mapToStackSummary(info: StackInfo, orgSlug?: string): StackSummary {
	return {
		id: info.id,
		orgName: orgSlug ?? info.orgName,
		projectName: info.projectName,
		stackName: info.stackName,
		lastUpdate: info.lastUpdate ?? undefined,
		resourceCount: info.resourceCount ?? undefined,
	};
}
