// @procella/server — Health and capabilities handlers.

import type { Database } from "@procella/db";
import type { CapabilitiesResponse, CLIVersionResponse } from "@procella/types";
import { BLOB_THRESHOLD } from "@procella/updates";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import type { Env } from "../types.js";

// ============================================================================
// Health Handlers
// ============================================================================

export function healthHandlers(deps: { db: Database; deltaCheckpointsEnabled?: boolean }) {
	return {
		health: async (c: Context<Env>) => {
			try {
				await deps.db.execute(sql`SELECT 1`);
				return c.json({ status: "ok" }, 200);
			} catch {
				return c.json({ status: "error", message: "database unreachable" }, 503);
			}
		},

		capabilities: (c: Context<Env>) =>
			c.json({
				capabilities: [
					{ capability: "batch-encrypt" },
					{ capability: "deployment-schema-version", version: 1, configuration: { version: 3 } },
					{ capability: "journaling-v1", version: 1 },
					...(deps.deltaCheckpointsEnabled
						? [
								{
									capability: "delta-checkpoint-uploads-v2" as const,
									version: 2,
									configuration: { checkpointCutoffSizeBytes: BLOB_THRESHOLD },
								},
							]
						: []),
				],
			} satisfies CapabilitiesResponse),

		cliVersion: (c: Context<Env>) =>
			c.json({
				latestVersion: "3.0.0",
				oldestWithoutWarning: "3.0.0",
				latestDevVersion: "3.0.0",
			} satisfies CLIVersionResponse),
	};
}
