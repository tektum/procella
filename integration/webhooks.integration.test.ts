import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "@procella/db";
import { PostgresWebhooksService } from "@procella/webhooks";
import { getTestDb, truncateTables } from "./setup.js";


let db: Database;
let webhooks: PostgresWebhooksService;

beforeAll(() => {
	db = getTestDb();
	webhooks = new PostgresWebhooksService({ db });
});

afterEach(async () => {
	await truncateTables();
});

describe("PostgresWebhooksService — integration", () => {
	// ========================================================================
	// createWebhook
	// ========================================================================

	describe("createWebhook", () => {
		test("creates webhook and returns secret", async () => {
			const result = await webhooks.createWebhook(
				"tenant-1",
				{
					name: "Deploy Hook",
					url: "https://www.google.com/webhook-test",
					events: ["update.succeeded"],
				},
				"user-1",
			);
			expect(result.id).toBeTruthy();
			expect(result.name).toBe("Deploy Hook");
			expect(result.url).toBe("https://www.google.com/webhook-test");
			expect(result.secret).toBeTruthy();
			expect(result.secret.length).toBeGreaterThan(10);
		});

		test("uses custom secret when provided", async () => {
			const result = await webhooks.createWebhook(
				"tenant-1",
				{
					name: "Hook",
					url: "https://www.google.com/hook-test",
					events: ["update.succeeded"],
					secret: "my-custom-secret",
				},
				"user-1",
			);
			expect(result.secret).toBe("my-custom-secret");
		});
	});

	// ========================================================================
	// listWebhooks
	// ========================================================================

	describe("listWebhooks", () => {
		test("returns all webhooks for tenant", async () => {
			await webhooks.createWebhook(
				"tenant-1",
				{ name: "Hook 1", url: "https://www.google.com/hook-a", events: ["update.succeeded"] },
				"user-1",
			);
			await webhooks.createWebhook(
				"tenant-1",
				{ name: "Hook 2", url: "https://www.google.com/hook-b", events: ["update.failed"] },
				"user-1",
			);

			const list = await webhooks.listWebhooks("tenant-1");
			expect(list).toHaveLength(2);
		});

		test("tenant isolation", async () => {
			await webhooks.createWebhook(
				"tenant-1",
				{ name: "Hook", url: "https://www.google.com/hook-test", events: ["update.succeeded"] },
				"user-1",
			);

			const list = await webhooks.listWebhooks("tenant-2");
			expect(list).toHaveLength(0);
		});
	});

	// ========================================================================
	// getWebhook / updateWebhook / deleteWebhook
	// ========================================================================

	describe("CRUD", () => {
		test("getWebhook returns webhook by ID", async () => {
			const created = await webhooks.createWebhook(
				"tenant-1",
				{ name: "Hook", url: "https://www.google.com/hook-test", events: ["update.succeeded"] },
				"user-1",
			);
			const fetched = await webhooks.getWebhook("tenant-1", created.id);
			expect(fetched).not.toBeNull();
			expect(fetched!.name).toBe("Hook");
		});

		test("getWebhook returns null for missing webhook", async () => {
			const result = await webhooks.getWebhook("tenant-1", "00000000-0000-0000-0000-000000000000");
			expect(result).toBeNull();
		});

		test("updateWebhook changes name and URL", async () => {
			const created = await webhooks.createWebhook(
				"tenant-1",
				{ name: "Hook", url: "https://www.google.com/old-hook", events: ["update.succeeded"] },
				"user-1",
			);
			const updated = await webhooks.updateWebhook("tenant-1", created.id, {
				name: "Updated Hook",
				url: "https://www.google.com/new-hook",
			});
			expect(updated.name).toBe("Updated Hook");
			expect(updated.url).toBe("https://www.google.com/new-hook");
		});

		test("deleteWebhook removes webhook", async () => {
			const created = await webhooks.createWebhook(
				"tenant-1",
				{ name: "Hook", url: "https://www.google.com/hook-test", events: ["update.succeeded"] },
				"user-1",
			);
			await webhooks.deleteWebhook("tenant-1", created.id);
			const result = await webhooks.getWebhook("tenant-1", created.id);
			expect(result).toBeNull();
		});
	});

	// ========================================================================
	// SSRF validation
	// ========================================================================

	describe("SSRF validation", () => {
		// Exhaustive URL cases live in packages/webhooks unit tests.
		// One integration case proves the service wires the validator in.
		test("rejects localhost URLs", async () => {
			await expect(
				webhooks.createWebhook(
					"tenant-1",
					{ name: "Evil", url: "http://localhost/hook", events: ["update.succeeded"] },
					"user-1",
				),
			).rejects.toThrow();
		});
	});
});
