import type { Database, DbClient } from "@procella/db";
import { sql } from "drizzle-orm";

interface PreviewDatabaseResetOptions {
	databaseName: string;
	enabled: boolean;
	openDatabase: () => Promise<{ db: Database; client: DbClient }>;
}

const PREVIEW_DATABASE_NAME = /^procella_pr_[1-9]\d*$/;

/** Clear OIDC fixtures only in an explicitly enabled ephemeral PR database. */
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
					END
				$$;`),
			);
		});
	} finally {
		await client.close();
	}
	return true;
}
