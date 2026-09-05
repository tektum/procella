import { describe, expect, mock, test } from "bun:test";
import type { Database } from "@procella/db";
import type { SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { resetPreviewDatabase } from "./preview-database-reset.js";

const dialect = new PgDialect();

function resetHarness(transactionError?: Error) {
	const execute = mock(async (_query: unknown) => []);
	const transaction = mock(
		async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) => {
			if (transactionError) throw transactionError;
			return callback({ execute });
		},
	);
	const close = mock(async () => undefined);
	const openDatabase = mock(async () => ({
		db: { transaction } as unknown as Database,
		client: { close },
	}));
	return { close, execute, openDatabase, transaction };
}

describe("resetPreviewDatabase", () => {
	test("clears only preview OIDC rows and the superseded migration marker", async () => {
		const harness = resetHarness();

		const reset = await resetPreviewDatabase({
			databaseName: "procella_pr_266",
			enabled: true,
			openDatabase: harness.openDatabase,
		});

		expect(reset).toBe(true);
		expect(harness.execute).toHaveBeenCalledTimes(1);
		expect(harness.transaction).toHaveBeenCalledTimes(1);
		expect(harness.close).toHaveBeenCalledTimes(1);

		const query = harness.execute.mock.calls[0]?.[0] as SQLWrapper;
		const resetSql = dialect.sqlToQuery(query.getSQL()).sql;
		expect(resetSql).toContain("to_regclass('public.oidc_trust_policies')");
		expect(resetSql).toContain('DELETE FROM "public"."oidc_trust_policies"');
		expect(resetSql).toContain("to_regclass('drizzle.__drizzle_migrations')");
		expect(resetSql).toContain('DELETE FROM "drizzle"."__drizzle_migrations"');
		expect(resetSql).toContain('"created_at" = 1788550736903');
		expect(resetSql).not.toContain("DROP SCHEMA");
		expect(resetSql).not.toContain('DELETE FROM "public"."updates"');
		expect(resetSql).not.toContain("github_update_outbox");
	});

	test("never opens production or malformed database names", async () => {
		for (const databaseName of [
			"procella",
			"postgres",
			"procella_pr_0",
			"procella_pr_266_backup",
		]) {
			const harness = resetHarness();
			expect(
				await resetPreviewDatabase({
					databaseName,
					enabled: true,
					openDatabase: harness.openDatabase,
				}),
			).toBe(false);
			expect(harness.openDatabase).not.toHaveBeenCalled();
		}
	});

	test("requires the explicit reset flag even for a PR database", async () => {
		const harness = resetHarness();

		expect(
			await resetPreviewDatabase({
				databaseName: "procella_pr_266",
				enabled: false,
				openDatabase: harness.openDatabase,
			}),
		).toBe(false);
		expect(harness.openDatabase).not.toHaveBeenCalled();
	});

	test("closes the database and propagates reset failure", async () => {
		const harness = resetHarness(new Error("reset failed"));

		await expect(
			resetPreviewDatabase({
				databaseName: "procella_pr_266",
				enabled: true,
				openDatabase: harness.openDatabase,
			}),
		).rejects.toThrow("reset failed");
		expect(harness.close).toHaveBeenCalledTimes(1);
	});
});
