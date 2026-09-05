import { describe, expect, mock, test } from "bun:test";
import type { StackCryptoInput } from "@procella/crypto";
import type { StackInfo, StacksService } from "@procella/stacks";
import { type Caller, Role, StackNotFoundError } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { cryptoHandlers } from "./crypto.js";

function toBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function testCaller(): Caller {
	return {
		tenantId: "tenant-a",
		orgSlug: "tenant-a",
		userId: "user-1",
		login: "user-1",
		roles: [Role.Admin],
		principalType: "token",
	};
}

function testStack(): StackInfo {
	const now = new Date();
	return {
		id: "11111111-1111-1111-1111-111111111111",
		projectId: "project-1",
		tenantId: "tenant-a",
		orgName: "tenant-a",
		projectName: "myproj",
		stackName: "dev",
		tags: {},
		activeUpdateId: null,
		lastUpdate: null,
		resourceCount: null,
		createdAt: now,
		updatedAt: now,
	};
}

function mockUpdatesService(overrides?: Partial<UpdatesService>): UpdatesService {
	return {
		createUpdate: mock(async () => ({}) as never),
		startUpdate: mock(async () => ({}) as never),
		completeUpdate: mock(async () => {}),
		cancelUpdate: mock(async () => {}),
		patchCheckpoint: mock(async () => {}),
		patchCheckpointVerbatim: mock(async () => {}),
		patchCheckpointDelta: mock(async () => {}),
		appendJournalEntries: mock(async () => {}),
		postEvents: mock(async () => {}),
		renewLease: mock(async () => ({}) as never),
		getUpdate: mock(async () => ({}) as never),
		getUpdateEvents: mock(async () => ({}) as never),
		getHistory: mock(async () => ({}) as never),
		exportStack: mock(async () => ({}) as never),
		importStack: mock(async () => ({}) as never),
		encryptValue: mock(async (_stack: StackCryptoInput) => new Uint8Array([99, 105, 112])),
		decryptValue: mock(async (_stack: StackCryptoInput) => new Uint8Array([112, 108, 110])),
		batchEncrypt: mock(async (_stack: StackCryptoInput, pts: Uint8Array[]) =>
			pts.map(() => new Uint8Array([99])),
		),
		batchDecrypt: mock(async (_stack: StackCryptoInput, cts: Uint8Array[]) =>
			cts.map(() => new Uint8Array([112])),
		),
		verifyLeaseToken: mock(async () => {}),
		verifyUpdateOwnership: mock(async () => {}),
		...overrides,
	};
}

function mockStacksService(overrides?: Partial<StacksService>): StacksService {
	return {
		createStack: mock(async () => testStack()),
		getStack: mock(async () => testStack()),
		listStacks: mock(async () => []),
		deleteStack: mock(async () => {}),
		renameStack: mock(async () => {}),
		updateStackTags: mock(async () => {}),
		replaceStackTags: mock(async () => {}),
		getStackByFQN: mock(async () => testStack()),
		getStackByNames_systemOnly: mock(async () => testStack()),
		getStackById_systemOnly: mock(async () => testStack()),
		...overrides,
	};
}

function createApp(updates: UpdatesService, stacks: StacksService): Hono<Env> {
	const app = new Hono<Env>();
	app.use("*", async (c, next) => {
		c.set("caller", testCaller());
		await next();
	});
	const handlers = cryptoHandlers(updates, stacks);
	app.post("/stacks/:org/:project/:stack/encrypt", handlers.encryptValue);
	app.post("/stacks/:org/:project/:stack/decrypt", handlers.decryptValue);
	app.post("/stacks/:org/:project/:stack/batch-encrypt", handlers.batchEncrypt);
	app.post("/stacks/:org/:project/:stack/batch-decrypt", handlers.batchDecrypt);
	app.post("/stacks/:org/:project/:stack/log-decryption", handlers.logDecryption);
	return app;
}

describe("cryptoHandlers", () => {
	test("encryptValue returns base64 ciphertext", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = createApp(updates, stacks);

		const plaintext = toBase64(new Uint8Array([104, 105]));
		const res = await app.request("/stacks/myorg/myproj/dev/encrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plaintext }),
		});

		expect(res.status).toBe(200);
		expect((await res.json()).ciphertext).toBe(toBase64(new Uint8Array([99, 105, 112])));
		expect(stacks.getStack).toHaveBeenCalledTimes(1);
		expect(updates.encryptValue).toHaveBeenCalledTimes(1);
	});

	test("encryptValue resolves tenant-owned stack and passes stack identity", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = createApp(updates, stacks);

		await app.request("/stacks/org1/proj1/stack1/encrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plaintext: toBase64(new Uint8Array([1])) }),
		});

		expect(stacks.getStack).toHaveBeenCalledWith("tenant-a", "org1", "proj1", "stack1");
		const call = (updates.encryptValue as ReturnType<typeof mock>).mock.calls[0];
		expect(call[0]).toEqual({
			stackId: "11111111-1111-1111-1111-111111111111",
			stackFQN: "org1/proj1/stack1",
		});
	});

	test("decryptValue returns base64 plaintext", async () => {
		const app = createApp(mockUpdatesService(), mockStacksService());
		const ciphertext = toBase64(new Uint8Array([1, 2, 3]));

		const res = await app.request("/stacks/myorg/myproj/dev/decrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ciphertext }),
		});

		expect(res.status).toBe(200);
		expect((await res.json()).plaintext).toBe(toBase64(new Uint8Array([112, 108, 110])));
	});

	test("batchEncrypt returns ciphertexts array", async () => {
		const updates = mockUpdatesService();
		const app = createApp(updates, mockStacksService());
		const plaintexts = [toBase64(new Uint8Array([1])), toBase64(new Uint8Array([2]))];

		const res = await app.request("/stacks/myorg/myproj/dev/batch-encrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plaintexts }),
		});

		expect(res.status).toBe(200);
		expect((await res.json()).ciphertexts).toHaveLength(2);
		expect(updates.batchEncrypt).toHaveBeenCalledTimes(1);
	});

	test("batchDecrypt returns plaintext map", async () => {
		const app = createApp(mockUpdatesService(), mockStacksService());
		const ct1 = toBase64(new Uint8Array([10]));
		const ct2 = toBase64(new Uint8Array([20]));

		const res = await app.request("/stacks/myorg/myproj/dev/batch-decrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ciphertexts: [ct1, ct2] }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.plaintexts[ct1]).toBeDefined();
		expect(body.plaintexts[ct2]).toBeDefined();
	});

	test("unauthorized stack access returns uniform 404 and skips decrypt", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService({
			getStack: mock(async () => {
				throw new StackNotFoundError("tenant-a", "proj1", "stack1");
			}),
		});
		const app = createApp(updates, stacks);

		const res = await app.request("/stacks/org1/proj1/stack1/decrypt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ciphertext: toBase64(new Uint8Array([1, 2, 3])) }),
		});

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "stack_not_found" });
		expect(updates.decryptValue).not.toHaveBeenCalled();
	});

	test("logDecryption returns 200 with empty body", async () => {
		const app = createApp(mockUpdatesService(), mockStacksService());
		const res = await app.request("/stacks/myorg/myproj/dev/log-decryption", { method: "POST" });
		expect(res.status).toBe(200);
	});
});
