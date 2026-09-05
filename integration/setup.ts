// Integration test lifecycle — uses real PostgreSQL (docker-compose or CI service).
// Pattern: runMigrations in beforeAll, truncateTables in afterEach.

import { afterAll, beforeAll } from "bun:test";
import { randomBytes } from "node:crypto";
import { createDb, runMigrations, type Database, type DbClient } from "@procella/db";

process.env.PROCELLA_AUTH_MODE ??= "dev";
process.env.PROCELLA_ENCRYPTION_KEY ??= randomBytes(32).toString("hex");
process.env.PROCELLA_CRON_SECRET ??= "integration-cron-secret";

const TEST_DB_URL =
	process.env.TEST_DATABASE_URL ??
	process.env.PROCELLA_DATABASE_URL ??
	"postgres://procella:procella@localhost:5432/procella?sslmode=disable";

const MIGRATIONS_PATH = new URL("../packages/db/drizzle", import.meta.url).pathname;

let _db: Database;
let _client: DbClient;

export function getTestDb(): Database {
	if (!_db) throw new Error("Test DB not initialized — is setup.ts loaded via --preload?");
	return _db;
}

export function getTestDbUrl(): string {
	return TEST_DB_URL;
}

export async function truncateTables(): Promise<void> {
	const { SQL } = require("bun") as typeof import("bun");
	const sql = new SQL({ url: TEST_DB_URL });
	await sql.unsafe(
		"TRUNCATE esc_sessions, esc_environment_revisions, esc_environments, esc_projects, webhook_deliveries, webhooks, github_update_outbox, github_setup_states, github_installations, oidc_trust_policies, update_events, journal_entries, checkpoints, updates, stacks, projects CASCADE",
	);
	await sql.close();
}

beforeAll(async () => {
	// Apply migrations (idempotent — drizzle-kit skips already-applied)
	await runMigrations(TEST_DB_URL, MIGRATIONS_PATH);

	// Create Drizzle instance for tests
	const result = await createDb({ url: TEST_DB_URL });
	_db = result.db;
	_client = result.client;
});

afterAll(async () => {
	await _client?.close();
});
