import { describe, expect, mock, test } from "bun:test";
import type { TRPCContext } from "../trpc.js";
import { webhooksRouter } from "./webhooks.js";

// ============================================================================
// Mock Data
// ============================================================================

const VALID_UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

const mockWebhook = {
	id: VALID_UUID,
	tenantId: "t-1",
	name: "Deploy Hook",
	url: "https://example.com/hook",
	events: ["update.succeeded"],
	active: true,
	createdAt: new Date("2025-01-01"),
	updatedAt: new Date("2025-01-01"),
	createdBy: "u-1",
};

const mockDelivery = {
	id: "delivery-1",
	webhookId: VALID_UUID,
	event: "update.succeeded",
	responseStatus: 200,
	success: true,
	attempt: 1,
	error: null,
	duration: 100,
	createdAt: new Date("2025-06-01"),
};

// ============================================================================
// Mock Context
// ============================================================================

function mockContext(overrides?: Partial<TRPCContext>): TRPCContext {
	return {
		caller: {
			tenantId: "t-1",
			orgSlug: "my-org",
			userId: "u-1",
			login: "admin",
			roles: ["admin"],
			principalType: "user",
		},
		resolveUserDisplayName: (subject) => Promise.resolve(subject),
		db: {} as never,
		dbUrl: "",
		stacks: {} as never,
		audit: {} as never,
		updates: {} as never,
		esc: {} as never,
		webhooks: {
			createWebhook: mock(async () => ({ ...mockWebhook, secret: "whsec_abc" })),
			listWebhooks: mock(async () => [mockWebhook]),
			getWebhook: mock(async () => mockWebhook),
			updateWebhook: mock(async () => mockWebhook),
			deleteWebhook: mock(async () => {}),
			listDeliveries: mock(async () => [mockDelivery]),
			emit: mock(() => {}),
			emitAndWait: mock(async () => {}),
			ping: mock(async () => mockDelivery),
		},
		github: null,
		...overrides,
	};
}

const viewerCtx = (): TRPCContext =>
	mockContext({
		caller: {
			tenantId: "t-1",
			orgSlug: "org",
			userId: "u-2",
			login: "viewer",
			roles: ["viewer"],
			principalType: "user",
		},
	});

// ============================================================================
// Tests
// ============================================================================

describe("webhooksRouter", () => {
	describe("list", () => {
		test("returns webhooks for admin", async () => {
			const ctx = mockContext();
			const caller = webhooksRouter.createCaller(ctx);
			const result = await caller.list();
			expect(result).toBeArray();
			expect(result).toHaveLength(1);
		});

		test("rejects non-admin", async () => {
			const caller = webhooksRouter.createCaller(viewerCtx());
			await expect(caller.list()).rejects.toThrow("Admin role required");
		});
	});

	describe("create", () => {
		test("creates webhook with valid input", async () => {
			const ctx = mockContext();
			const caller = webhooksRouter.createCaller(ctx);
			const result = await caller.create({
				name: "New Hook",
				url: "https://example.com/new",
				events: ["update.succeeded"],
			});
			expect(result.secret).toBe("whsec_abc");
			expect(ctx.webhooks.createWebhook).toHaveBeenCalledTimes(1);
		});

		test("rejects invalid URL", async () => {
			const ctx = mockContext();
			const caller = webhooksRouter.createCaller(ctx);
			await expect(
				caller.create({ name: "Hook", url: "not-a-url", events: ["update.succeeded"] }),
			).rejects.toThrow();
		});

		test("rejects empty events array", async () => {
			const ctx = mockContext();
			const caller = webhooksRouter.createCaller(ctx);
			await expect(
				caller.create({ name: "Hook", url: "https://example.com", events: [] }),
			).rejects.toThrow();
		});

		test("rejects non-admin", async () => {
			const caller = webhooksRouter.createCaller(viewerCtx());
			await expect(
				caller.create({
					name: "Hook",
					url: "https://example.com",
					events: ["update.succeeded"],
				}),
			).rejects.toThrow("Admin role required");
		});
	});

	describe("get", () => {
		test("returns webhook by id", async () => {
			const ctx = mockContext();
			const caller = webhooksRouter.createCaller(ctx);
			const result = await caller.get({ webhookId: VALID_UUID });
			expect(result.id).toBe(VALID_UUID);
		});

		test("throws NOT_FOUND when webhook missing", async () => {
			const ctx = mockContext({
				webhooks: {
					...mockContext().webhooks,
					getWebhook: mock(async () => null),
				},
			});
			const caller = webhooksRouter.createCaller(ctx);
			await expect(
				caller.get({ webhookId: "00000000-0000-0000-0000-000000000000" }),
			).rejects.toThrow("Webhook not found");
		});

		test("rejects non-UUID webhookId", async () => {
			const ctx = mockContext();
			const caller = webhooksRouter.createCaller(ctx);
			await expect(caller.get({ webhookId: "not-a-uuid" })).rejects.toThrow();
		});
	});

	describe("update", () => {
		test("updates webhook", async () => {
			const ctx = mockContext();
			const caller = webhooksRouter.createCaller(ctx);
			const result = await caller.update({
				webhookId: VALID_UUID,
				name: "Updated",
			});
			expect(result.id).toBe(VALID_UUID);
		});
	});

	describe("delete", () => {
		test("deletes webhook and returns success", async () => {
			const ctx = mockContext();
			const caller = webhooksRouter.createCaller(ctx);
			const result = await caller.delete({ webhookId: VALID_UUID });
			expect(result.success).toBe(true);
			expect(ctx.webhooks.deleteWebhook).toHaveBeenCalledWith("t-1", VALID_UUID);
		});
	});

	describe("ping", () => {
		test("sends test webhook", async () => {
			const ctx = mockContext();
			const caller = webhooksRouter.createCaller(ctx);
			const result = await caller.ping({ webhookId: VALID_UUID });
			expect(result.success).toBe(true);
		});
	});
});
