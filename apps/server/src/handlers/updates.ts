// @procella/server — Update lifecycle handlers.

import {
	buildPRCommentBody,
	type GitHubService,
	mapUpdateStatusToCommitState,
} from "@procella/github";
import type { StacksService } from "@procella/stacks";
import {
	type CompleteUpdateRequest,
	isValidUpdateKind,
	type StartUpdateRequest,
	type UpdateProgramRequest,
} from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param, updateContext } from "./params.js";

// ============================================================================
// Update Handlers
// ============================================================================

export function updateHandlers(
	updates: UpdatesService,
	stacks: StacksService,
	webhooks?: WebhooksService,
	github?: GitHubService | null,
) {
	return {
		createUpdate: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const kind = param(c, "kind");
			if (!isValidUpdateKind(kind)) {
				return c.json({ code: "invalid_kind", message: `Invalid update kind: ${kind}` }, 400);
			}
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			const body = await c.req.json().catch(() => ({}));
			const typedBody = body as Partial<UpdateProgramRequest> & { program?: unknown };
			const result = await updates.createUpdate(
				stackInfo.id,
				kind,
				typedBody.config,
				typedBody.program,
				caller,
				typedBody.metadata?.environment,
			);
			return c.json(result);
		},

		startUpdate: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const updateId = param(c, "updateId");
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			await updates.verifyUpdateOwnership(updateId, stackInfo.id);
			const body = await c.req.json<StartUpdateRequest>();
			const result = await updates.startUpdate(updateId, body);
			if (org) {
				void webhooks?.emit({
					tenantId: caller.tenantId,
					event: "update.started",
					data: { org, project, stack, updateId },
				});
			}
			return c.json(result);
		},

		completeUpdate: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			const updateId = updateCtx.updateId;
			const body = await c.req.json<CompleteUpdateRequest>();
			await updates.completeUpdate(updateId, body);

			const caller = c.get("caller");
			const org = c.req.param("org");
			const project = c.req.param("project");
			const stack = c.req.param("stack");

			// Safe: updateAuth already verified that this URL tuple resolves to the
			// same stackId that the lease token is bound to before any side effects run.
			if (
				org &&
				project &&
				stack &&
				github &&
				(body.status === "succeeded" || body.status === "failed")
			) {
				void (async () => {
					const completed = await updates.getUpdateContext(updateId);
					const stackInfo = await stacks.getStackById_systemOnly(completed.stackId);
					const installation = await github.getInstallation(stackInfo.tenantId);
					if (!installation) {
						return;
					}

					const taggedOwner = stackInfo.tags["github:owner"];
					const taggedRepo = stackInfo.tags["github:repo"];
					const taggedPr = stackInfo.tags["github:pr"];
					const taggedSha = stackInfo.tags["github:sha"];
					const taggedTarget =
						taggedOwner && taggedRepo && taggedPr && taggedSha
							? { owner: taggedOwner, repo: taggedRepo, pr: taggedPr, sha: taggedSha }
							: null;

					const metadataOwner = completed.environment["vcs.owner"];
					const metadataRepo = completed.environment["vcs.repo"];
					const metadataPr = completed.environment["ci.pr.number"];
					const metadataSha =
						completed.environment["ci.pr.headSHA"] ?? completed.environment["git.head"];
					const metadataMatchesStack =
						metadataOwner === stackInfo.tags["vcs:owner"] &&
						metadataRepo === stackInfo.tags["vcs:repo"];
					const metadataTarget =
						metadataMatchesStack && metadataOwner && metadataRepo && metadataPr && metadataSha
							? { owner: metadataOwner, repo: metadataRepo, pr: metadataPr, sha: metadataSha }
							: null;
					const target = taggedTarget ?? metadataTarget;
					if (!target) return;

					const prNumber = Number(target.pr);
					if (Number.isNaN(prNumber)) return;

					const latest = await updates.getHistory(stackInfo.id);
					const summary = latest.updates[0];
					const commitState = mapUpdateStatusToCommitState(body.status);
					await github.setCommitStatus(
						installation.installationId,
						target.owner,
						target.repo,
						target.sha,
						commitState,
						`Procella ${body.status}`,
					);

					const resourceChanges = summary?.resourceChanges as Record<string, number> | undefined;
					const commentBody = buildPRCommentBody({
						org,
						project,
						stack,
						kind: summary?.kind ?? "update",
						status: body.status,
						resourceChanges: {
							creates: resourceChanges?.create ?? resourceChanges?.creates,
							updates: resourceChanges?.update ?? resourceChanges?.updates,
							deletes: resourceChanges?.delete ?? resourceChanges?.deletes,
							sames: resourceChanges?.same ?? resourceChanges?.sames,
						},
					});
					await github.postPRComment(
						installation.installationId,
						target.owner,
						target.repo,
						prNumber,
						commentBody,
					);
				})().catch((error: unknown) => {
					console.error("[updates] Failed to publish GitHub update status", error);
				});
			}

			if (
				caller &&
				org &&
				project &&
				stack &&
				webhooks &&
				(body.status === "succeeded" || body.status === "failed" || body.status === "cancelled")
			) {
				let tenantId = org;
				try {
					const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
					tenantId = stackInfo.tenantId;
				} catch (_) {}
				await webhooks
					.emitAndWait({
						tenantId,
						event:
							body.status === "succeeded"
								? "update.succeeded"
								: body.status === "failed"
									? "update.failed"
									: "update.cancelled",
						data: { org, project, stack, updateId, status: body.status },
					})
					.catch((error: unknown) => {
						console.error("[updates] Failed to emit webhook for completeUpdate", error);
					});
			}
			return c.body(null, 204);
		},

		cancelUpdate: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const updateId = param(c, "updateId");
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			await updates.verifyUpdateOwnership(updateId, stackInfo.id);
			await updates.cancelUpdate(updateId);
			return c.body(null, 204);
		},

		getUpdate: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const updateId = param(c, "updateId");
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			await updates.verifyUpdateOwnership(updateId, stackInfo.id);
			const result = await updates.getUpdate(updateId);
			return c.json(result);
		},

		getHistory: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			const result = await updates.getHistory(stackInfo.id);
			return c.json(result);
		},
	};
}
