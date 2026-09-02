// E2E test helpers — server lifecycle, Pulumi CLI wrapper, DB cleanup.

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { SQL } from "bun";

// ============================================================================
// Constants
// ============================================================================

export const TEST_PORT = 18_080;
export const TEST_TOKEN = "devtoken123";
export const TEST_TOKEN_USER_B = "token-user-b";
export const TEST_DEV_USERS =
	'[{"token":"token-user-b","login":"user-b","org":"org-b","role":"admin"},{"token":"token-viewer","login":"viewer-user","org":"dev-org","role":"viewer"}]';
export const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");
export const TEST_TICKET_SIGNING_KEY = "ticket-signing-key-ticket-signing-key";
export const TEST_CRON_SECRET = "test-cron-secret";
export const TEST_DB_URL =
	process.env.PROCELLA_DATABASE_URL ||
	"postgres://procella:procella@localhost:5432/procella?sslmode=disable";
export const BACKEND_URL = `http://127.0.0.1:${TEST_PORT}`;
export const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const ESC_EVAL_BOOTSTRAP = path.join(PROJECT_ROOT, ".build/esc-eval/bootstrap");

// ============================================================================
// Database Setup
// ============================================================================

/** Drop all old tables and recreate schema from Drizzle migration. */
export async function resetDatabase(): Promise<void> {
	const sql = new SQL({ url: TEST_DB_URL });
	await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
	await sql.unsafe("DROP SCHEMA public CASCADE");
	await sql.unsafe("CREATE SCHEMA public");
	sql.close();

	const proc = Bun.spawn(
		["bunx", "drizzle-kit", "migrate", "--config", "packages/db/drizzle.config.ts"],
		{
			env: { ...cleanEnv(), PROCELLA_DATABASE_URL: TEST_DB_URL },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
		throw new Error(`drizzle-kit migrate failed (exit ${exitCode}): ${stderr}`);
	}
}

/** Truncate all tables (fast cleanup between test groups). */
export async function truncateTables(): Promise<void> {
	const sql = new SQL({ url: TEST_DB_URL });
	await sql.unsafe(
		"TRUNCATE update_events, journal_entries, checkpoints, updates, stacks, projects CASCADE",
	);
	sql.close();
}

// ============================================================================
// Docker Compose
// ============================================================================

export async function ensureDeps(): Promise<void> {
	// In CI, the database is provided as a service — skip docker compose.
	// Locally, .env may define PROCELLA_DATABASE_URL but we still need docker compose.
	if (process.env.CI) {
		return;
	}

	const proc = Bun.spawn(["docker", "compose", "up", "-d", "postgres"], {
		stdout: "pipe",
		stderr: "pipe",
		cwd: PROJECT_ROOT,
	});
	const exit = await proc.exited;
	if (exit !== 0) {
		const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
		throw new Error(`docker compose up failed: ${stderr}`);
	}

	const start = Date.now();
	while (Date.now() - start < 30_000) {
		const pg = Bun.spawn(
			["docker", "compose", "exec", "-T", "postgres", "pg_isready", "-U", "procella"],
			{ stdout: "pipe", stderr: "pipe", cwd: PROJECT_ROOT },
		);
		if ((await pg.exited) === 0) return;
		await Bun.sleep(300);
	}
	throw new Error("Postgres did not become ready within 30s");
}

// ============================================================================
// Temp Directory Helpers
// ============================================================================

export async function createPulumiHome(): Promise<string> {
	const home = await mkdtemp(path.join(tmpdir(), "procella-e2e-pulumi-"));
	// Copy plugins from system PULUMI_HOME to avoid GitHub rate limits
	const systemHome = process.env.PULUMI_HOME ?? path.join(process.env.HOME ?? "", ".pulumi");
	const systemPlugins = path.join(systemHome, "plugins");
	const homePlugins = path.join(home, "plugins");
	try {
		const cp = Bun.spawn(["cp", "-rf", systemPlugins, homePlugins], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await cp.exited;
	} catch {
		// Ignore if system plugins dir doesn't exist
	}
	return home;
}

export async function cleanupDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}

export async function newProjectDir(name: string, runtime = "yaml"): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), `procella-e2e-${name}-`));
	await Bun.write(path.join(dir, "Pulumi.yaml"), `name: ${name}\nruntime: ${runtime}\n`);
	return dir;
}

export async function copyExampleDir(name: string): Promise<string> {
	const src = path.join(PROJECT_ROOT, "examples", name);
	const dir = await mkdtemp(path.join(tmpdir(), `procella-e2e-${name}-`));

	const cp = Bun.spawn(["cp", "-rf", `${src}/.`, dir], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await cp.exited;

	return dir;
}

// ============================================================================
// Server Lifecycle
// ============================================================================

function cleanEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("PROCELLA_")) continue;
		if (key.startsWith("AWS_")) continue;
		if (value !== undefined) env[key] = value;
	}
	return env;
}

export async function startServer(): Promise<Subprocess> {
	const escEvaluatorBinary = await ensureEscEvaluatorBinary();
	const proc = Bun.spawn(["bun", "run", "apps/server/src/index.ts"], {
		env: {
			...cleanEnv(),
			PROCELLA_LISTEN_ADDR: `:${TEST_PORT}`,
			PROCELLA_DATABASE_URL: TEST_DB_URL,
			PROCELLA_AUTH_MODE: "dev",
			PROCELLA_DEV_AUTH_TOKEN: TEST_TOKEN,
			PROCELLA_DEV_USERS: TEST_DEV_USERS,
			PROCELLA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
			PROCELLA_TICKET_SIGNING_KEY: TEST_TICKET_SIGNING_KEY,
			PROCELLA_CRON_SECRET: TEST_CRON_SECRET,
			PROCELLA_BLOB_BACKEND: "local",
			PROCELLA_BLOB_LOCAL_PATH: "./data/e2e-blobs",
			...(escEvaluatorBinary ? { PROCELLA_ESC_EVALUATOR_BINARY: escEvaluatorBinary } : {}),
			...(process.env.PROCELLA_OTEL_ENABLED
				? { PROCELLA_OTEL_ENABLED: process.env.PROCELLA_OTEL_ENABLED }
				: {}),
		},
		stdout: "ignore",
		stderr: "inherit",
	});

	await waitForHealth(`${BACKEND_URL}/healthz`, 30_000);
	return proc;
}

export async function stopServer(proc: Subprocess): Promise<void> {
	proc.kill("SIGTERM");
	await proc.exited;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {
			/* retry */
		}
		await Bun.sleep(200);
	}
	throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
}

async function ensureEscEvaluatorBinary(): Promise<string | undefined> {
	if (await Bun.file(ESC_EVAL_BOOTSTRAP).exists()) {
		return ESC_EVAL_BOOTSTRAP;
	}

	const proc = Bun.spawn(["make", "-C", "esc-eval", "build"], {
		cwd: PROJECT_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode === 0 && (await Bun.file(ESC_EVAL_BOOTSTRAP).exists())) {
		return ESC_EVAL_BOOTSTRAP;
	}
	return undefined;
}

// ============================================================================
// Pulumi CLI Wrapper
// ============================================================================

export interface PulumiResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface PulumiOpts {
	cwd?: string;
	pulumiHome?: string;
	env?: Record<string, string>;
}

export async function pulumi(args: string[], opts?: PulumiOpts): Promise<PulumiResult> {
	const proc = Bun.spawn(["pulumi", ...args, "--non-interactive"], {
		env: {
			...cleanEnv(),
			PULUMI_ACCESS_TOKEN: TEST_TOKEN,
			PULUMI_BACKEND_URL: BACKEND_URL,
			PULUMI_CONFIG_PASSPHRASE: "test",
			PULUMI_SKIP_UPDATE_CHECK: "true",
			PULUMI_DIY_BACKEND_URL: "",
			...(opts?.pulumiHome ? { PULUMI_HOME: opts.pulumiHome } : {}),
			...opts?.env,
		},
		cwd: opts?.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	// Collect output chunks to avoid pipe deadlock with large outputs
	const stdoutChunks: Uint8Array[] = [];
	const stderrChunks: Uint8Array[] = [];
	const stdoutStream = proc.stdout as AsyncIterable<Uint8Array>;
	const stderrStream = proc.stderr as AsyncIterable<Uint8Array>;

	const stdoutDone = (async () => {
		for await (const chunk of stdoutStream) {
			stdoutChunks.push(chunk);
		}
	})();
	const stderrDone = (async () => {
		for await (const chunk of stderrStream) {
			stderrChunks.push(chunk);
		}
	})();

	const [exitCode] = await Promise.all([proc.exited, stdoutDone, stderrDone]);
	const decoder = new TextDecoder();
	const stdout = stdoutChunks.map((c) => decoder.decode(c, { stream: true })).join("");
	const stderr = stderrChunks.map((c) => decoder.decode(c, { stream: true })).join("");
	return { stdout, stderr, exitCode };
}

// ============================================================================
// HTTP API Helpers
// ============================================================================

export async function apiRequest(
	path: string,
	opts?: { method?: string; body?: unknown; token?: string; accept?: string | null },
): Promise<Response> {
	return fetch(`${BACKEND_URL}/api${path}`, {
		method: opts?.method ?? "GET",
		headers: {
			Authorization: `token ${opts?.token ?? TEST_TOKEN}`,
			...(opts?.accept !== null ? { Accept: opts?.accept ?? "application/vnd.pulumi+8" } : {}),
			...(opts?.body ? { "Content-Type": "application/json" } : {}),
		},
		body: opts?.body ? JSON.stringify(opts.body) : undefined,
	});
}
