import type { Database, DbClient } from "@procella/db";
import { sql } from "drizzle-orm";

interface PreviewDatabaseResetOptions {
	databaseName: string;
	enabled: boolean;
	openDatabase: () => Promise<{ db: Database; client: DbClient }>;
}

const PREVIEW_DATABASE_NAME = /^procella_pr_[1-9]\d*$/;

// Journal timestamp for 0017_global_oidc_policy_ownership on pre-rebase PR #266
// head 4500597952ed34275fad8ca5153824279f93d5ad.
const SUPERSEDED_PREVIEW_MIGRATION_TIMESTAMP = 1788550736903;

/** Reset the preview OIDC fixture once when the superseded migration marker exists. */
export async function resetPreviewDatabase({
	databaseName,
	enabled,
	openDatabase,
}: PreviewDatabaseResetOptions): Promise<boolean> {
	if (!enabled || !PREVIEW_DATABASE_NAME.test(databaseName)) return false;

	const { db, client } = await openDatabase();
	try {
		return await db.transaction(async (tx) => {
			const [tables] = await tx.execute(
				sql.raw(`SELECT
					to_regclass('public.oidc_trust_policies') AS oidc_trust_policies,
					to_regclass('drizzle.__drizzle_migrations') AS drizzle_migrations`),
			);
			if (!tables?.oidc_trust_policies || !tables.drizzle_migrations) return false;

			const [marker] = await tx.execute(sql`
				SELECT 1 AS "found"
				FROM "drizzle"."__drizzle_migrations"
				WHERE "created_at" = ${SUPERSEDED_PREVIEW_MIGRATION_TIMESTAMP}
				LIMIT 1
			`);
			if (!marker) return false;

			await tx.execute(sql.raw('DELETE FROM "public"."oidc_trust_policies"'));
			await tx.execute(sql`
				DELETE FROM "drizzle"."__drizzle_migrations"
				WHERE "created_at" = ${SUPERSEDED_PREVIEW_MIGRATION_TIMESTAMP}
			`);
			return true;
		});
	} finally {
		await client.close();
	}
}
