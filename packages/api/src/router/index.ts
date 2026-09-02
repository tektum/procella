// @procella/api — Root tRPC AppRouter definition.

import { router } from "../trpc.js";
import { auditRouter } from "./audit.js";
import { authRouter } from "./auth.js";
import { escRouter } from "./esc.js";
import { eventsRouter } from "./events.js";
import { githubRouter } from "./github.js";
import { oidcRouter } from "./oidc.js";
import { stacksRouter } from "./stacks.js";
import { subscriptionsRouter } from "./subscriptions.js";
import { updatesRouter } from "./updates.js";
import { webhooksRouter } from "./webhooks.js";

// ============================================================================
// App Router
// ============================================================================

export const appRouter = router({
	auth: authRouter,
	stacks: stacksRouter,
	audit: auditRouter,
	updates: updatesRouter,
	events: eventsRouter,
	esc: escRouter,
	github: githubRouter,
	webhooks: webhooksRouter,
	oidc: oidcRouter,
	subscriptions: subscriptionsRouter,
});

export type AppRouter = typeof appRouter;
