// @procella/server — Health and capabilities handlers.

import { type Database, LATEST_MIGRATION_TIMESTAMP, readExecuteRows } from "@procella/db";
import type { CapabilitiesResponse, CLIVersionResponse } from "@procella/types";
import { BLOB_THRESHOLD } from "@procella/updates";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import type { Env } from "../types.js";

// ============================================================================
// Health Handlers
// ============================================================================

/**
 * Relations Procella needs before it can serve or persist state. `SELECT 1`
 * alone only proves the connection is up, so a deployment that never ran
 * migrations reports healthy and then fails every stack and update call.
 */
const REQUIRED_RELATIONS = [
	"public.projects",
	"public.stacks",
	"public.updates",
	"public.checkpoints",
	"drizzle.__drizzle_migrations",
] as const;

const SCHEMA_READINESS_SQL = `SELECT ${REQUIRED_RELATIONS.map(
	(relation, index) => `to_regclass('${relation}') AS relation_${index}`,
).join(", ")}`;

export function healthHandlers(deps: { db: Database; deltaCheckpointsEnabled?: boolean }) {
	return {
		health: async (c: Context<Env>) => {
			try {
				const [relations] = readExecuteRows(await deps.db.execute(sql.raw(SCHEMA_READINESS_SQL)));
				const relationsExist = REQUIRED_RELATIONS.every((_, index) =>
					Boolean(relations?.[`relation_${index}`]),
				);
				if (!relationsExist) {
					return c.json({ status: "error", message: "database schema not migrated" }, 503);
				}

				const [migration] = readExecuteRows(
					await deps.db.execute(sql`
					SELECT EXISTS (
						SELECT 1 FROM "drizzle"."__drizzle_migrations"
						WHERE "created_at" = ${LATEST_MIGRATION_TIMESTAMP}
					) AS migrated
				`),
				);
				if (migration?.migrated !== true) {
					return c.json({ status: "error", message: "database schema not migrated" }, 503);
				}
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
					{ capability: "stack-outputs", version: 1 },
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
