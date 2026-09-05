import { describe, expect, mock, test } from "bun:test";
import type { Database } from "@procella/db";
import type { SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { resetPreviewDatabase } from "./preview-database-reset.js";

const dialect = new PgDialect();

function resetHarness(options: { executeResults?: unknown[]; transactionError?: Error } = {}) {
	let executeCall = 0;
	const execute = mock(async (_query: unknown) => options.executeResults?.[executeCall++] ?? []);
	const transaction = mock(
		async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) => {
			if (options.transactionError) throw options.transactionError;
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
	test("removes preview OIDC rows and the exact superseded marker atomically", async () => {
		const harness = resetHarness({
			executeResults: [
				[
					{
						oidc_trust_policies: "oidc_trust_policies",
						drizzle_migrations: "__drizzle_migrations",
					},
				],
				[{ found: 1 }],
				[],
				[],
			],
		});

		const reset = await resetPreviewDatabase({
			databaseName: "procella_pr_266",
			enabled: true,
			openDatabase: harness.openDatabase,
		});

		expect(reset).toBe(true);
		expect(harness.execute).toHaveBeenCalledTimes(4);
		expect(harness.transaction).toHaveBeenCalledTimes(1);
		expect(harness.close).toHaveBeenCalledTimes(1);

		const tableQuery = harness.execute.mock.calls[0]?.[0] as SQLWrapper;
		const tableSql = dialect.sqlToQuery(tableQuery.getSQL()).sql;
		expect(tableSql).toContain("to_regclass('public.oidc_trust_policies')");
		expect(tableSql).toContain("to_regclass('drizzle.__drizzle_migrations')");

		const markerQuery = harness.execute.mock.calls[1]?.[0] as SQLWrapper;
		const marker = dialect.sqlToQuery(markerQuery.getSQL());
		expect(marker.sql).toContain('FROM "drizzle"."__drizzle_migrations"');
		expect(marker.params).toEqual([1788550736903]);

		const policyDelete = harness.execute.mock.calls[2]?.[0] as SQLWrapper;
		const policyDeleteSql = dialect.sqlToQuery(policyDelete.getSQL()).sql;
		expect(policyDeleteSql).toBe('DELETE FROM "public"."oidc_trust_policies"');
		expect(policyDeleteSql).not.toContain('"updates"');
		expect(policyDeleteSql).not.toContain("github_update_outbox");

		const markerDelete = harness.execute.mock.calls[3]?.[0] as SQLWrapper;
		const markerDeletion = dialect.sqlToQuery(markerDelete.getSQL());
		expect(markerDeletion.sql).toContain('DELETE FROM "drizzle"."__drizzle_migrations"');
		expect(markerDeletion.sql).toContain('"created_at" >=');
		expect(markerDeletion.params).toEqual([1788550736903]);
	});

	test("normalizes Neon query-result rows", async () => {
		const harness = resetHarness({
			executeResults: [
				{
					rows: [
						{
							oidc_trust_policies: "oidc_trust_policies",
							drizzle_migrations: "__drizzle_migrations",
						},
					],
				},
				{ rows: [{ found: 1 }] },
				{ rows: [] },
				{ rows: [] },
			],
		});

		expect(
			await resetPreviewDatabase({
				databaseName: "procella_pr_266",
				enabled: true,
				openDatabase: harness.openDatabase,
			}),
		).toBe(true);
		expect(harness.execute).toHaveBeenCalledTimes(4);
	});

	test("does not write when the superseded marker is absent", async () => {
		const harness = resetHarness({
			executeResults: [
				[
					{
						oidc_trust_policies: "oidc_trust_policies",
						drizzle_migrations: "__drizzle_migrations",
					},
				],
				[],
			],
		});

		expect(
			await resetPreviewDatabase({
				databaseName: "procella_pr_266",
				enabled: true,
				openDatabase: harness.openDatabase,
			}),
		).toBe(false);
		expect(harness.execute).toHaveBeenCalledTimes(2);
		for (const [query] of harness.execute.mock.calls) {
			expect(dialect.sqlToQuery((query as SQLWrapper).getSQL()).sql).not.toContain("DELETE");
		}
	});

	test("repeated invocation becomes a no-op after consuming the marker", async () => {
		const tables = {
			oidc_trust_policies: "oidc_trust_policies",
			drizzle_migrations: "__drizzle_migrations",
		};
		const harness = resetHarness({
			executeResults: [[tables], [{ found: 1 }], [], [], [tables], []],
		});
		const options = {
			databaseName: "procella_pr_266",
			enabled: true,
			openDatabase: harness.openDatabase,
		};

		expect(await resetPreviewDatabase(options)).toBe(true);
		expect(await resetPreviewDatabase(options)).toBe(false);
		expect(harness.execute).toHaveBeenCalledTimes(6);
		const statements = harness.execute.mock.calls.map(
			([query]) => dialect.sqlToQuery((query as SQLWrapper).getSQL()).sql,
		);
		expect(statements.filter((statement) => statement.includes("DELETE"))).toHaveLength(2);
	});

	test("does nothing when either guarded table is absent", async () => {
		for (const tables of [
			{ oidc_trust_policies: null, drizzle_migrations: "__drizzle_migrations" },
			{ oidc_trust_policies: "oidc_trust_policies", drizzle_migrations: null },
		]) {
			const harness = resetHarness({ executeResults: [[tables]] });
			expect(
				await resetPreviewDatabase({
					databaseName: "procella_pr_266",
					enabled: true,
					openDatabase: harness.openDatabase,
				}),
			).toBe(false);
			expect(harness.execute).toHaveBeenCalledTimes(1);
		}
	});

	test("never opens production, dev, or malformed database names", async () => {
		for (const databaseName of [
			"procella",
			"procella_dev",
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
		const harness = resetHarness({ transactionError: new Error("reset failed") });

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
