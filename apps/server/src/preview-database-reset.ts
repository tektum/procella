import type { Database, DbClient } from "@procella/db";
import { sql } from "drizzle-orm";

interface PreviewDatabaseResetOptions {
	databaseName: string;
	enabled: boolean;
	openDatabase: () => Promise<{ db: Database; client: DbClient }>;
}

const PREVIEW_DATABASE_NAME = /^procella_pr_[1-9]\d*$/;
const LEGACY_PREVIEW_OWNERSHIP_MIGRATION_TIMESTAMP = 1788550736903;

/** Clear preview-only OIDC fixtures and repair the superseded PR migration marker. */
export async function resetPreviewDatabase({
	databaseName,
	enabled,
	openDatabase,
}: PreviewDatabaseResetOptions): Promise<boolean> {
	if (!enabled || !PREVIEW_DATABASE_NAME.test(databaseName)) return false;

	const { db, client } = await openDatabase();
	try {
		await db.transaction(async (tx) => {
			await tx.execute(
				sql.raw(`DO $$
					BEGIN
						IF to_regclass('public.oidc_trust_policies') IS NOT NULL THEN
							DELETE FROM "public"."oidc_trust_policies";
						END IF;
						IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
							DELETE FROM "drizzle"."__drizzle_migrations"
							WHERE "created_at" = ${LEGACY_PREVIEW_OWNERSHIP_MIGRATION_TIMESTAMP};
						END IF;
					END
				$$;`),
			);
		});
	} finally {
		await client.close();
	}
	return true;
}
