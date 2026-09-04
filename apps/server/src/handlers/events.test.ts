import { describe, expect, mock, test } from "bun:test";
import type { StackInfo, StacksService } from "@procella/stacks";
import type { Caller } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import { Hono } from "hono";
import { errorHandler } from "../middleware/error-handler.js";
import type { Env } from "../types.js";
import { eventHandlers } from "./events.js";

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
	tags: {},
	activeUpdateId: null,
	lastUpdate: null,
	resourceCount: null,
	createdAt: new Date("2025-01-01"),
	updatedAt: new Date("2025-01-01"),
};

function mockStacksService(): StacksService {
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
	};
}

function injectCaller(caller: Caller) {
	return async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
		c.set("caller", caller);
		await next();
	};
}

function mockUpdatesService(overrides?: Partial<UpdatesService>): UpdatesService {
	return {
		createUpdate: mock(async () => ({ updateID: "", requiredPolicies: [] }) as never),
		startUpdate: mock(async () => ({}) as never),
		completeUpdate: mock(async () => {}),
		cancelUpdate: mock(async () => {}),
		patchCheckpoint: mock(async () => {}),
		patchCheckpointVerbatim: mock(async () => {}),
		patchCheckpointDelta: mock(async () => {}),
		appendJournalEntries: mock(async () => {}),
		postEvents: mock(async () => {}),
		renewLease: mock(async () => ({ token: "new-lease", tokenExpiration: 1735693200 }) as never),
		getUpdate: mock(async () => ({}) as never),
		getUpdateEvents: mock(
			async () =>
				({
					events: [{ sequence: 1, kind: "stdout", fields: {} }],
					continuationToken: "tok-2",
				}) as never,
		),
		getHistory: mock(async () => ({}) as never),
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

function injectUpdateContext(updateId: string, stackId: string) {
	return async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
		c.set("updateContext", { updateId, stackId });
		await next();
	};
}

describe("eventHandlers", () => {
	test("postEvents calls service and returns 200", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectUpdateContext("u-1", "s-1"));
		const h = eventHandlers(updates, mockStacksService());
		app.post("/events", h.postEvents);

		const body = { events: [{ sequence: 1, timestamp: 0 }] };
		const res = await app.request("/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		expect(res.status).toBe(200);
		expect(updates.postEvents).toHaveBeenCalledTimes(1);
		expect(updates.postEvents).toHaveBeenCalledWith("u-1", body);
	});

	test("getUpdateEvents returns events with continuationToken", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = eventHandlers(updates, mockStacksService());
		app.get("/stacks/:org/:project/:stack/update/:updateId/events", h.getUpdateEvents);

		const res = await app.request("/stacks/myorg/myproj/dev/update/upd-42/events");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.events).toBeArray();
		expect(body.continuationToken).toBe("tok-2");
		expect(updates.getUpdateEvents).toHaveBeenCalledWith("upd-42", undefined);
	});

	test("getUpdateEvents passes continuationToken query param", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = eventHandlers(updates, mockStacksService());
		app.get("/stacks/:org/:project/:stack/update/:updateId/events", h.getUpdateEvents);

		const res = await app.request(
			"/stacks/myorg/myproj/dev/update/upd-42/events?continuationToken=tok-1",
		);
		expect(res.status).toBe(200);
		expect(updates.getUpdateEvents).toHaveBeenCalledWith("upd-42", "tok-1");
	});

	test("renewLease calls service and returns new token", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectUpdateContext("u-5", "s-5"));
		const h = eventHandlers(updates, mockStacksService());
		app.post("/renew", h.renewLease);

		const reqBody = { token: "old-lease", duration: 300 };
		const res = await app.request("/renew", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(reqBody),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.token).toBe("new-lease");
		expect(body.tokenExpiration).toBe(1735693200);
		expect(updates.renewLease).toHaveBeenCalledWith("u-5", reqBody);
	});

	test("postEvents throws when updateContext is not set", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.onError(errorHandler());
		const h = eventHandlers(updates, mockStacksService());
		app.post("/events", h.postEvents);

		const res = await app.request("/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ events: [] }),
		});

		expect(res.status).toBe(400);
	});
});
