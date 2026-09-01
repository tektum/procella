// @procella/api — tRPC initialization and context definition.

import type { AuditService } from "@procella/audit";
import type { Database } from "@procella/db";
import type { EscService } from "@procella/esc";
import type { GitHubService } from "@procella/github";
import type { TrustPolicyRepository } from "@procella/oidc";
import type { StacksService } from "@procella/stacks";
import { trpcProcedureDuration, withSpan } from "@procella/telemetry";
import type { Caller } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";

// ============================================================================
// Context
// ============================================================================

export interface TRPCContext {
	caller: Caller | null;
	issueSubscriptionTicket?: (caller: Caller) => Promise<string>;
	resolveUserDisplayName: (subject: string) => Promise<string | null>;
	db: Database;
	dbUrl: string;
	stacks: StacksService;
	audit: AuditService;
	updates: UpdatesService;
	webhooks: WebhooksService;
	esc: EscService;
	github: GitHubService | null;
	oidcPolicies?: TrustPolicyRepository | null;
}

// ============================================================================
// tRPC Instance
// ============================================================================

const t = initTRPC.context<TRPCContext>().create({
	transformer: superjson,
});

const tracingMiddleware = t.middleware(async (ctx) => {
	const start = performance.now();

	return withSpan(
		"procella.trpc",
		`trpc.${ctx.path ?? "unknown"}`,
		{ "trpc.type": ctx.type },
		async () => {
			try {
				return await ctx.next();
			} finally {
				trpcProcedureDuration().record(performance.now() - start, {
					"trpc.procedure": ctx.path ?? "unknown",
					"trpc.type": ctx.type,
				});
			}
		},
	);
});

const protectedMiddleware = t.middleware(async ({ ctx, next }) => {
	if (!ctx.caller) {
		throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
	}

	return next({
		ctx: {
			...ctx,
			caller: ctx.caller,
		},
	});
});

const adminMiddleware = t.middleware(async ({ ctx, next }) => {
	if (!ctx.caller) {
		throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
	}

	if (!ctx.caller.roles.includes("admin")) {
		throw new TRPCError({ code: "FORBIDDEN", message: "Admin role required" });
	}

	return next({
		ctx: {
			...ctx,
			caller: ctx.caller,
		},
	});
});

// Keep bare t.procedure usage confined to this file.
const instrumentedProcedure = t.procedure.use(tracingMiddleware);

export const router = t.router;
export const publicProcedure = instrumentedProcedure;
export const protectedProcedure = instrumentedProcedure.use(protectedMiddleware);
export const adminProcedure = instrumentedProcedure.use(adminMiddleware);
