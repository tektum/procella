import { describe, expect, mock, test } from "bun:test";
import type { StackInfo, StacksService } from "@procella/stacks";
import type { Caller } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { updateHandlers } from "./updates.js";

const validCaller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "u-1",
	login: "test-user",
	roles: ["admin"],
	principalType: "user",
};

const mockStackInfo: StackInfo = {
	id: "stack-uuid-1",
	projectId: "proj-uuid-1",
	tenantId: "t-1",
	orgName: "myorg",
	projectName: "myproj",
	stackName: "dev",
	tags: { env: "dev" },
	activeUpdateId: null,
	lastUpdate: null,
	resourceCount: null,
	createdAt: new Date("2025-01-01"),
	updatedAt: new Date("2025-01-01"),
};

function mockStacksService(overrides?: Partial<StacksService>): StacksService {
	return {
		createStack: mock(async () => mockStackInfo),
		getStack: mock(async () => mockStackInfo),
		listStacks: mock(async () => [mockStackInfo]),
		deleteStack: mock(async () => {}),
		renameStack: mock(async () => {}),
		updateStackTags: mock(async () => {}),
		replaceStackTags: mock(async () => {}),
		getStackByFQN: mock(async () => mockStackInfo),
		getStackByNames_systemOnly: mock(async () => mockStackInfo),
		getStackById_systemOnly: mock(async () => mockStackInfo),
		...overrides,
	};
}

const mockCreateResult = { updateID: "upd-1", requiredPolicies: [] };
const mockStartResult = { version: 1, token: "lease-tok", tokenExpiration: "2025-01-01T01:00:00Z" };
const mockGetUpdateResult = { status: "succeeded", startTime: 0, endTime: 1 };
const mockHistoryResult = { updates: [] };

function mockUpdatesService(overrides?: Partial<UpdatesService>): UpdatesService {
	return {
		createUpdate: mock(async () => mockCreateResult as never),
		startUpdate: mock(async () => mockStartResult as never),
		completeUpdate: mock(async () => {}),
		cancelUpdate: mock(async () => {}),
		patchCheckpoint: mock(async () => {}),
		patchCheckpointVerbatim: mock(async () => {}),
		patchCheckpointDelta: mock(async () => {}),
		appendJournalEntries: mock(async () => {}),
		postEvents: mock(async () => {}),
		renewLease: mock(async () => ({}) as never),
		getUpdate: mock(async () => mockGetUpdateResult as never),
		getUpdateEvents: mock(async () => ({}) as never),
		getHistory: mock(async () => mockHistoryResult as never),
		exportStack: mock(async () => ({}) as never),
		importStack: mock(async () => ({}) as never),
		encryptValue: mock(async () => new Uint8Array()),
		decryptValue: mock(async () => new Uint8Array()),
		batchEncrypt: mock(async () => []),
		batchDecrypt: mock(async () => []),
		verifyLeaseToken: mock(async () => {}),
		verifyUpdateOwnership: mock(async () => {}),
		...overrides,
	};
}

function injectCaller(caller: Caller) {
	return async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
		c.set("caller", caller);
		await next();
	};
}

describe("updateHandlers", () => {
	test("createUpdate returns updateID and requiredPolicies", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = updateHandlers(updates, stacks);
		app.post("/stacks/:org/:project/:stack/:kind", h.createUpdate);

		const res = await app.request("/stacks/myorg/myproj/dev/update", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				config: { key: "val" },
				metadata: { environment: { "ci.pr.number": "42" } },
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.updateID).toBe("upd-1");
		expect(body.requiredPolicies).toBeArray();
		expect(stacks.getStack).toHaveBeenCalledWith("t-1", "myorg", "myproj", "dev");
		expect(updates.createUpdate).toHaveBeenCalledWith(
			"stack-uuid-1",
			"update",
			{ key: "val" },
			undefined,
			validCaller,
			{ "ci.pr.number": "42" },
		);
	});

	test("createUpdate handles empty body gracefully", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = updateHandlers(updates, stacks);
		app.post("/stacks/:org/:project/:stack/:kind", h.createUpdate);

		const res = await app.request("/stacks/myorg/myproj/dev/preview", {
			method: "POST",
		});

		expect(res.status).toBe(200);
		expect(updates.createUpdate).toHaveBeenCalledWith(
			"stack-uuid-1",
			"preview",
			undefined,
			undefined,
			validCaller,
			undefined,
		);
	});

	test("createUpdate rejects invalid kind with 400", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = updateHandlers(updates, stacks);
		app.post("/stacks/:org/:project/:stack/:kind", h.createUpdate);

		const res = await app.request("/stacks/myorg/myproj/dev/badkind", {
			method: "POST",
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			code: "invalid_kind",
			message: "Invalid update kind: badkind",
		});
		expect(stacks.getStack).not.toHaveBeenCalled();
		expect(updates.createUpdate).not.toHaveBeenCalled();
	});

	test("startUpdate returns version, token, and expiration", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = updateHandlers(updates, stacks);
		app.post("/stacks/:org/:project/:stack/update/:updateId", h.startUpdate);

		const reqBody = { tags: { "pulumi:target": "*" } };
		const res = await app.request("/stacks/myorg/myproj/dev/update/upd-1", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(reqBody),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.version).toBe(1);
		expect(body.token).toBe("lease-tok");
		expect(body.tokenExpiration).toBe("2025-01-01T01:00:00Z");
		expect(stacks.getStack).toHaveBeenCalledWith("t-1", "myorg", "myproj", "dev");
		expect(updates.verifyUpdateOwnership).toHaveBeenCalled();
		expect(updates.startUpdate).toHaveBeenCalledWith("upd-1", reqBody);
	});

	test("completeUpdate returns 204", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", async (c, next) => {
			c.set("updateContext", { updateId: "upd-1", stackId: "s-1" });
			await next();
		});
		const h = updateHandlers(updates, stacks);
		app.post("/updates/:updateId/complete", h.completeUpdate);

		const reqBody = { status: "succeeded" };
		const res = await app.request("/updates/upd-1/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(reqBody),
		});

		expect(res.status).toBe(204);
		expect(updates.completeUpdate).toHaveBeenCalledWith("upd-1", reqBody);
	});

	test("cancelUpdate returns 204", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = updateHandlers(updates, stacks);
		app.post("/stacks/:org/:project/:stack/update/:updateId/cancel", h.cancelUpdate);

		const res = await app.request("/stacks/myorg/myproj/dev/update/upd-1/cancel", {
			method: "POST",
		});
		expect(res.status).toBe(204);
		expect(stacks.getStack).toHaveBeenCalledWith("t-1", "myorg", "myproj", "dev");
		expect(updates.verifyUpdateOwnership).toHaveBeenCalled();
		expect(updates.cancelUpdate).toHaveBeenCalledWith("upd-1");
	});

	test("getUpdate returns update results", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = updateHandlers(updates, stacks);
		app.get("/stacks/:org/:project/:stack/update/:updateId", h.getUpdate);

		const res = await app.request("/stacks/myorg/myproj/dev/update/upd-42");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("succeeded");
		expect(stacks.getStack).toHaveBeenCalledWith("t-1", "myorg", "myproj", "dev");
		expect(updates.verifyUpdateOwnership).toHaveBeenCalled();
		expect(updates.getUpdate).toHaveBeenCalledWith("upd-42");
	});

	test("getHistory returns updates array", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = updateHandlers(updates, stacks);
		app.get("/stacks/:org/:project/:stack/updates", h.getHistory);

		const res = await app.request("/stacks/myorg/myproj/dev/updates");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.updates).toBeArray();
		expect(stacks.getStack).toHaveBeenCalledWith("t-1", "myorg", "myproj", "dev");
		expect(updates.getHistory).toHaveBeenCalledWith("stack-uuid-1");
	});

	test("completeUpdate emits webhook on succeeded status", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const webhookEmitAndWait = mock(async () => {});
		const webhooks = { emit: mock(() => {}), emitAndWait: webhookEmitAndWait } as never;
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		app.use("*", async (c, next) => {
			c.set("updateContext", { updateId: "upd-1", stackId: "s-1" });
			await next();
		});
		const h = updateHandlers(updates, stacks, webhooks);
		app.post("/stacks/:org/:project/:stack/update/:updateId/complete", h.completeUpdate);

		const res = await app.request("/stacks/myorg/myproj/dev/update/upd-1/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "succeeded" }),
		});
		expect(res.status).toBe(204);
		// emitAndWait is awaited by the handler before responding 204
		expect(webhookEmitAndWait).toHaveBeenCalledTimes(1);
		const call = (webhookEmitAndWait as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(call.event).toBe("update.succeeded");
	});

	test("completeUpdate emits webhook on failed status", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const webhookEmitAndWait = mock(async () => {});
		const webhooks = { emit: mock(() => {}), emitAndWait: webhookEmitAndWait } as never;
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		app.use("*", async (c, next) => {
			c.set("updateContext", { updateId: "upd-2", stackId: "s-1" });
			await next();
		});
		const h = updateHandlers(updates, stacks, webhooks);
		app.post("/stacks/:org/:project/:stack/update/:updateId/complete", h.completeUpdate);

		const res = await app.request("/stacks/myorg/myproj/dev/update/upd-2/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "failed" }),
		});
		expect(res.status).toBe(204);
		// emitAndWait is awaited by the handler before responding 204
		expect(webhookEmitAndWait).toHaveBeenCalledTimes(1);
		const call = (webhookEmitAndWait as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(call.event).toBe("update.failed");
	});

	test("startUpdate emits webhook event", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const webhookEmit = mock(() => {});
		const webhooks = { emit: webhookEmit, emitAndWait: mock(async () => {}) } as never;
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = updateHandlers(updates, stacks, webhooks);
		app.post("/stacks/:org/:project/:stack/update/:updateId", h.startUpdate);

		const res = await app.request("/stacks/myorg/myproj/dev/update/upd-1", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tags: {} }),
		});
		expect(res.status).toBe(200);
		expect(webhookEmit).toHaveBeenCalledTimes(1);
		const call = (webhookEmit as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(call.event).toBe("update.started");
	});
});
