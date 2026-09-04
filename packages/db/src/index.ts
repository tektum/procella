// @procella/db — Database connection via Drizzle ORM.
//
// Dual-driver design:
//   - Standard PostgreSQL: Bun.sql (native, fastest).
//   - Neon serverless:     @neondatabase/serverless Pool over WebSocket.
//
// The driver is selected automatically based on the connection URL hostname.
// Neon connection strings use *.neon.tech hosts; everything else (localhost,
// 127.0.0.1, Docker hostnames, RDS, Supabase) uses Bun's native driver.

import { schema } from "./schema.js";

// Re-export schema for consumers
export {
	checkpoints,
	escDrafts,
	escEnvironmentRevisions,
	escEnvironments,
	escProjects,
	escRevisionTags,
	escSessions,
	githubInstallations,
	githubSetupStates,
	githubUpdateOutbox,
	journalEntries,
	oidcTrustPolicies,
	projects,
	schema,
	stacks,
	updateEvents,
	updates,
	webhookDeliveries,
	webhooks,
} from "./schema.js";

// ============================================================================
// Types
// ============================================================================

/** Drizzle database instance with full schema type inference. */
// Both BunSQLDatabase and NeonDatabase extend PgDatabase, so consumers get
// the full Drizzle query/mutation/transaction API regardless of the driver.
// biome-ignore lint/suspicious/noExplicitAny: PgDatabase requires QueryResultHKT generic which differs per driver
export type Database = import("drizzle-orm/pg-core").PgDatabase<any, typeof schema>;

/** Options for creating a database connection via URL (Bun.sql or Neon). */
export interface CreateDbOptions {
	/** PostgreSQL connection URL. */
	url: string;
	/** Maximum number of connections in the pool. Defaults to 20. */
	max?: number;
	/** Idle connection timeout in milliseconds. Defaults to 30_000. */
	idleTimeout?: number;
}

/** Wrapper around the connection pool for lifecycle management. */
export interface DbClient {
	/** Shut down the connection pool. */
	close(): Promise<void>;
}

// ============================================================================
// Driver Detection
// ============================================================================

function isNeonHost(url: string): boolean {
	try {
		// PostgreSQL URLs use postgres:// or postgresql:// scheme.
		// URL parser needs a known scheme — swap to http for parsing.
		const normalized = url.replace(/^postgres(ql)?:\/\//, "http://");
		const { hostname } = new URL(normalized);
		return hostname.endsWith(".neon.tech");
	} catch {
		return false;
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a Drizzle database instance with automatic driver selection.
 *
 * - Neon hosts (*.neon.tech) → @neondatabase/serverless (WebSocket)
 * - All other hosts → Bun.sql (native TCP, fastest)
 *
 * Returns both the Drizzle instance (for type-safe queries) and a client
 * handle (for lifecycle management — call client.close() on shutdown).
 */
export async function createDb(
	options: CreateDbOptions,
): Promise<{ db: Database; client: DbClient }> {
	if (!isNeonHost(options.url)) {
		const { SQL } = require("bun") as typeof import("bun");
		const { drizzle } = await import("drizzle-orm/bun-sql");
		const client = new SQL({
			url: options.url,
			max: options.max ?? 20,
			idleTimeout: Math.max(1, Math.ceil((options.idleTimeout ?? 30_000) / 1000)),
		});
		const db = drizzle({ client, schema });
		return { db: db as Database, client: { close: () => client.close() } };
	}

	const { neonConfig, Pool } = await import("@neondatabase/serverless");
	const { drizzle } = await import("drizzle-orm/neon-serverless");

	// Fall back to the `ws` npm package only when no global WebSocket is available.
	if (typeof globalThis.WebSocket === "undefined") {
		neonConfig.webSocketConstructor = (await import("ws")).default;
	}

	const pool = new Pool({
		connectionString: options.url,
		max: options.max ?? 20,
		idleTimeoutMillis: options.idleTimeout ?? 30_000,
	});
	const db = drizzle({ client: pool, schema });
	return { db: db as Database, client: { close: () => pool.end() } };
}

/**
 * Convenience overload — create a Drizzle instance from just a URL string.
 */
export async function createDbFromUrl(
	databaseUrl: string,
): Promise<{ db: Database; client: DbClient }> {
	return createDb({ url: databaseUrl });
}

// ============================================================================
// Migrations
// ============================================================================

export async function ensureDatabase(adminUrl: string, dbName: string): Promise<void> {
	if (!isNeonHost(adminUrl)) {
		const { SQL } = require("bun") as typeof import("bun");
		const client = new SQL({ url: adminUrl });
		try {
			const rows = await client.unsafe("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
			if (rows.length === 0) {
				await client.unsafe(`CREATE DATABASE "${dbName}"`);
			}
		} finally {
			await client.close();
		}
		return;
	}

	const { neonConfig, Pool } = await import("@neondatabase/serverless");
	if (typeof globalThis.WebSocket === "undefined") {
		neonConfig.webSocketConstructor = (await import("ws")).default;
	}
	const pool = new Pool({ connectionString: adminUrl });
	try {
		const { rows } = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
		if (rows.length === 0) {
			await pool.query(`CREATE DATABASE "${dbName}"`);
		}
	} finally {
		await pool.end();
	}
}

export async function runMigrations(
	options: CreateDbOptions | string,
	migrationsFolder: string,
): Promise<void> {
	const resolved: CreateDbOptions = typeof options === "string" ? { url: options } : options;
	const url = resolved.url;
	if (!isNeonHost(url)) {
		const { SQL } = require("bun") as typeof import("bun");
		const { drizzle } = await import("drizzle-orm/bun-sql");
		const { migrate } = await import("drizzle-orm/bun-sql/migrator");
		const client = new SQL({ url });
		try {
			const db = drizzle({ client });
			await migrate(db, { migrationsFolder });
		} finally {
			await client.close();
		}
		return;
	}

	const { neonConfig, Pool } = await import("@neondatabase/serverless");
	const { drizzle } = await import("drizzle-orm/neon-serverless");
	const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
	if (typeof globalThis.WebSocket === "undefined") {
		neonConfig.webSocketConstructor = (await import("ws")).default;
	}

	const pool = new Pool({ connectionString: url });
	try {
		const db = drizzle({ client: pool });
		await migrate(db, { migrationsFolder });
	} finally {
		await pool.end();
	}
}
