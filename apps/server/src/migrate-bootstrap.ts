import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@procella/config";
import { createDb, ensureDatabase, runMigrations } from "@procella/db";
import { resetPreviewDatabase } from "./preview-database-reset.js";

(async () => {
	const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API!;
	const BASE_URL = `http://${RUNTIME_API}/2018-06-01/runtime`;

	const config = loadConfig();
	const dbUrl = config.databaseUrl as string;

	const taskDir = join(process.cwd(), "drizzle");
	const devDir = join(__dirname, "../../../packages/db/drizzle");
	const migrationsDir = existsSync(taskDir) ? taskDir : devDir;

	const res = await fetch(`${BASE_URL}/invocation/next`);
	const requestId = res.headers.get("Lambda-Runtime-Aws-Request-Id")!;

	try {
		const parsed = new URL(dbUrl.replace(/^postgres(ql)?:\/\//, "http://"));
		const dbName = parsed.pathname.slice(1).split("?")[0];
		if (dbName && dbName !== "postgres") {
			await ensureDatabase(dbUrl.replace(`/${dbName}`, "/postgres"), dbName);
		}

		await resetPreviewDatabase({
			databaseName: dbName,
			enabled: process.env.PROCELLA_RESET_PREVIEW_DATABASE === "true",
			openDatabase: () => createDb({ url: dbUrl }),
		});

		await runMigrations(dbUrl, migrationsDir);

		await fetch(`${BASE_URL}/invocation/${requestId}/response`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "ok", message: "Migrations complete" }),
		});
	} catch (err: unknown) {
		const error = err instanceof Error ? err : new Error(String(err));
		await fetch(`${BASE_URL}/invocation/${requestId}/error`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				errorMessage: error.message,
				errorType: error.name,
				stackTrace: error.stack?.split("\n") || [],
			}),
		});
	}
})();
