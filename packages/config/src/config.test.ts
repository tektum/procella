import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { formatConfigErrors, loadConfig, tryLoadConfig } from "./index.js";

// Save original env and restore after each test
let savedEnv: Record<string, string | undefined>;

function setMinimalEnv() {
	Bun.env.PROCELLA_DATABASE_URL =
		"postgres://procella:procella@localhost:5432/procella?sslmode=disable";
	Bun.env.PROCELLA_AUTH_MODE = "dev";
	Bun.env.PROCELLA_DEV_AUTH_TOKEN = "devtoken123";
	Bun.env.PROCELLA_TICKET_SIGNING_KEY = "ticket-signing-key-ticket-signing-key";
}

function clearProcellaEnv() {
	for (const key of Object.keys(Bun.env)) {
		if (key.startsWith("PROCELLA_")) {
			delete Bun.env[key];
		}
	}
}

beforeEach(() => {
	savedEnv = {};
	for (const key of Object.keys(Bun.env)) {
		if (key.startsWith("PROCELLA_") || key.startsWith("AWS_") || key === "PORT") {
			savedEnv[key] = Bun.env[key];
		}
	}
});

afterEach(() => {
	clearProcellaEnv();
	delete Bun.env.PORT;
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value !== undefined) {
			Bun.env[key] = value;
		}
	}
});

describe("@procella/config", () => {
	describe("loadConfig", () => {
		test("loads minimal dev config with defaults", () => {
			clearProcellaEnv();
			setMinimalEnv();
			const config = loadConfig();
			expect(config.listenAddr).toBe(":9090");
			expect(config.databaseUrl).toBe(
				"postgres://procella:procella@localhost:5432/procella?sslmode=disable",
			);
			expect(config.authMode).toBe("dev");
			expect(config.devAuthToken).toBe("devtoken123");
			expect(config.devUserLogin).toBe("dev-user");
			expect(config.devOrgLogin).toBe("dev-org");
			expect(config.ticketSigningKey).toBe("ticket-signing-key-ticket-signing-key");
			expect(config.blobBackend).toBe("local");
			expect(config.blobLocalPath).toBe("./data/blobs");
			expect(config.deltaCheckpointsEnabled).toBe(false);
		});

		test("loads full config with all overrides", () => {
			clearProcellaEnv();
			setMinimalEnv();
			Bun.env.PROCELLA_LISTEN_ADDR = ":9090";
			Bun.env.PROCELLA_DEV_USER_LOGIN = "custom-user";
			Bun.env.PROCELLA_DEV_ORG_LOGIN = "custom-org";
			Bun.env.PROCELLA_BLOB_BACKEND = "s3";
			Bun.env.PROCELLA_BLOB_S3_BUCKET = "my-bucket";
			Bun.env.PROCELLA_BLOB_S3_ENDPOINT = "http://localhost:9000";
			Bun.env.PROCELLA_ENCRYPTION_KEY = "a".repeat(64);

			const config = loadConfig();
			expect(config.listenAddr).toBe(":9090");
			expect(config.devUserLogin).toBe("custom-user");
			expect(config.devOrgLogin).toBe("custom-org");
			expect(config.blobBackend).toBe("s3");
			expect(config.blobS3Bucket).toBe("my-bucket");
			expect(config.blobS3Endpoint).toBe("http://localhost:9000");
			expect(config.encryptionKey).toBe("a".repeat(64));
		});

		test("parses PROCELLA_DELTA_CHECKPOINTS_ENABLED true/false/1/0 and defaults false", () => {
			clearProcellaEnv();
			setMinimalEnv();
			expect(loadConfig().deltaCheckpointsEnabled).toBe(false);

			Bun.env.PROCELLA_DELTA_CHECKPOINTS_ENABLED = "true";
			expect(loadConfig().deltaCheckpointsEnabled).toBe(true);

			Bun.env.PROCELLA_DELTA_CHECKPOINTS_ENABLED = "1";
			expect(loadConfig().deltaCheckpointsEnabled).toBe(true);

			Bun.env.PROCELLA_DELTA_CHECKPOINTS_ENABLED = "false";
			expect(loadConfig().deltaCheckpointsEnabled).toBe(false);

			Bun.env.PROCELLA_DELTA_CHECKPOINTS_ENABLED = "0";
			expect(loadConfig().deltaCheckpointsEnabled).toBe(false);
		});

		test("throws on missing database URL", () => {
			clearProcellaEnv();
			Bun.env.PROCELLA_AUTH_MODE = "dev";
			Bun.env.PROCELLA_DEV_AUTH_TOKEN = "token";
			expect(() => loadConfig()).toThrow();
		});

		test("throws when dev mode lacks auth token", () => {
			clearProcellaEnv();
			Bun.env.PROCELLA_DATABASE_URL = "postgres://localhost:5432/procella?sslmode=disable";
			Bun.env.PROCELLA_AUTH_MODE = "dev";
			Bun.env.PROCELLA_TICKET_SIGNING_KEY = "ticket-signing-key-ticket-signing-key";
			expect(() => loadConfig()).toThrow();
		});

		test("throws when descope mode lacks project ID", () => {
			clearProcellaEnv();
			Bun.env.PROCELLA_DATABASE_URL = "postgres://localhost:5432/procella?sslmode=disable";
			Bun.env.PROCELLA_AUTH_MODE = "descope";
			Bun.env.PROCELLA_TICKET_SIGNING_KEY = "ticket-signing-key-ticket-signing-key";
			expect(() => loadConfig()).toThrow();
		});

		test("allows missing ticket signing key (enforced in bootstrap, not schema)", () => {
			clearProcellaEnv();
			Bun.env.PROCELLA_DATABASE_URL = "postgres://localhost:5432/procella?sslmode=disable";
			Bun.env.PROCELLA_AUTH_MODE = "dev";
			Bun.env.PROCELLA_DEV_AUTH_TOKEN = "token";
			const config = loadConfig();
			expect(config.ticketSigningKey).toBeUndefined();
		});

		test("throws when ticket signing key is too short", () => {
			clearProcellaEnv();
			Bun.env.PROCELLA_DATABASE_URL = "postgres://localhost:5432/procella?sslmode=disable";
			Bun.env.PROCELLA_AUTH_MODE = "dev";
			Bun.env.PROCELLA_DEV_AUTH_TOKEN = "token";
			Bun.env.PROCELLA_TICKET_SIGNING_KEY = "too-short";
			expect(() => loadConfig()).toThrow();
		});

		test("throws when auth mode is missing", () => {
			clearProcellaEnv();
			Bun.env.PROCELLA_DATABASE_URL = "postgres://localhost:5432/procella?sslmode=disable";
			Bun.env.PROCELLA_DEV_AUTH_TOKEN = "token";
			expect(() => loadConfig()).toThrow();
		});

		test("throws when s3 backend lacks bucket", () => {
			clearProcellaEnv();
			setMinimalEnv();
			Bun.env.PROCELLA_BLOB_BACKEND = "s3";
			expect(() => loadConfig()).toThrow();
		});

		test("throws on invalid encryption key format", () => {
			clearProcellaEnv();
			setMinimalEnv();
			Bun.env.PROCELLA_ENCRYPTION_KEY = "not-hex";
			expect(() => loadConfig()).toThrow();
		});

		test("allows missing encryption key in dev mode", () => {
			clearProcellaEnv();
			setMinimalEnv();
			// No PROCELLA_ENCRYPTION_KEY set — should be fine in dev
			const config = loadConfig();
			expect(config.encryptionKey).toBeUndefined();
		});

		test("allows missing encryption key in descope mode", () => {
			clearProcellaEnv();
			Bun.env.PROCELLA_DATABASE_URL = "postgres://localhost:5432/procella?sslmode=disable";
			Bun.env.PROCELLA_AUTH_MODE = "descope";
			Bun.env.PROCELLA_DESCOPE_PROJECT_ID = "P3test";
			const config = loadConfig();
			expect(config.encryptionKey).toBeUndefined();
		});

		test("falls back to PORT env var when PROCELLA_LISTEN_ADDR is not set", () => {
			clearProcellaEnv();
			setMinimalEnv();
			delete Bun.env.PROCELLA_LISTEN_ADDR;
			Bun.env.PORT = "3000";
			const config = loadConfig();
			expect(config.listenAddr).toBe(":3000");
		});

		test("PROCELLA_LISTEN_ADDR takes precedence over PORT", () => {
			clearProcellaEnv();
			setMinimalEnv();
			Bun.env.PROCELLA_LISTEN_ADDR = ":8080";
			Bun.env.PORT = "3000";
			const config = loadConfig();
			expect(config.listenAddr).toBe(":8080");
		});

		test("normalizes PORT with leading colon", () => {
			clearProcellaEnv();
			setMinimalEnv();
			delete Bun.env.PROCELLA_LISTEN_ADDR;
			Bun.env.PORT = ":3000";
			const config = loadConfig();
			expect(config.listenAddr).toBe(":3000");
		});

		test("ignores non-numeric PORT value", () => {
			clearProcellaEnv();
			setMinimalEnv();
			delete Bun.env.PROCELLA_LISTEN_ADDR;
			Bun.env.PORT = "not-a-port";
			const config = loadConfig();
			expect(config.listenAddr).toBe(":9090");
		});

		test("accepts complete GitHub app configuration", () => {
			clearProcellaEnv();
			setMinimalEnv();
			Bun.env.PROCELLA_GITHUB_APP_ID = "12345";
			Bun.env.PROCELLA_GITHUB_APP_SLUG = "procella-test";
			Bun.env.PROCELLA_GITHUB_APP_PRIVATE_KEY = "-----BEGIN KEY-----\\nline\\n-----END KEY-----";
			Bun.env.PROCELLA_GITHUB_APP_WEBHOOK_SECRET = "secret";

			const config = loadConfig();
			expect(config.githubAppSlug).toBe("procella-test");
			expect(config.githubAppId).toBe("12345");
			expect(config.githubAppPrivateKey).toContain("\nline\n");
			expect(config.githubAppWebhookSecret).toBe("secret");
		});

		test("throws when GitHub app configuration is partial", () => {
			clearProcellaEnv();
			setMinimalEnv();
			Bun.env.PROCELLA_GITHUB_APP_ID = "12345";
			Bun.env.PROCELLA_GITHUB_APP_SLUG = "procella-test";
			expect(() => loadConfig()).toThrow();
		});

		test("rejects an invalid GitHub App slug", () => {
			clearProcellaEnv();
			setMinimalEnv();
			Bun.env.PROCELLA_GITHUB_APP_ID = "12345";
			Bun.env.PROCELLA_GITHUB_APP_SLUG = "Invalid Slug";
			Bun.env.PROCELLA_GITHUB_APP_PRIVATE_KEY = "private-key";
			Bun.env.PROCELLA_GITHUB_APP_WEBHOOK_SECRET = "secret";
			expect(() => loadConfig()).toThrow();
		});
	});

	describe("tryLoadConfig", () => {
		test("returns ok result on valid config", () => {
			clearProcellaEnv();
			setMinimalEnv();
			const result = tryLoadConfig();
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.authMode).toBe("dev");
			}
		});

		test("returns error result on invalid config", () => {
			clearProcellaEnv();
			const result = tryLoadConfig();
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.issues.length).toBeGreaterThan(0);
			}
		});
	});

	describe("formatConfigErrors", () => {
		test("formats errors with PROCELLA_* env var names", () => {
			clearProcellaEnv();
			const result = tryLoadConfig();
			expect(result.ok).toBe(false);
			if (!result.ok) {
				const formatted = formatConfigErrors(result.error);
				expect(formatted).toContain("PROCELLA_DATABASE_URL");
				expect(formatted).toContain("✗");
			}
		});
	});
});
