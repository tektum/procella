import { describe, expect, mock, test } from "bun:test";
import type { StackInfo, StacksService } from "@procella/stacks";
import type { Caller } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { stateHandlers } from "./state.js";

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

const mockExportResult = {
	version: 3,
	deployment: { manifest: { time: "2025-01-01", magic: "" }, resources: [] },
};

const mockImportResult = { updateID: "import-1" };

function mockUpdatesService(overrides?: Partial<UpdatesService>): UpdatesService {
	return {
		createUpdate: mock(async () => ({}) as never),
		startUpdate: mock(async () => ({}) as never),
		completeUpdate: mock(async () => {}),
		cancelUpdate: mock(async () => true),
		patchCheckpoint: mock(async () => {}),
		patchCheckpointVerbatim: mock(async () => {}),
		patchCheckpointDelta: mock(async () => {}),
		appendJournalEntries: mock(async () => {}),
		postEvents: mock(async () => {}),
		renewLease: mock(async () => ({}) as never),
		getUpdate: mock(async () => ({}) as never),
		getUpdateEvents: mock(async () => ({}) as never),
		getHistory: mock(async () => ({}) as never),
		exportStack: mock(async () => mockExportResult as never),
		importStack: mock(async () => mockImportResult as never),
		repairStack: mock(async () => []),
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

describe("stateHandlers", () => {
	test("exportStack returns deployment JSON", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = stateHandlers(updates, stacks);
		app.get("/stacks/:org/:project/:stack/export", h.exportStack);

		const res = await app.request("/stacks/myorg/myproj/dev/export");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.version).toBe(3);
		expect(body.deployment).toBeDefined();
		expect(updates.exportStack).toHaveBeenCalledWith("stack-uuid-1", undefined);
	});

	test("stackOutputs returns root outputs and secret-provider metadata", async () => {
		const updates = mockUpdatesService({
			exportStack: mock(
				async () =>
					({
						version: 3,
						deployment: {
							manifest: { time: "2025-01-01", magic: "" },
							secrets_providers: { type: "passphrase", state: { salt: "salt" } },
							resources: [
								{ urn: "urn:provider", type: "pulumi:providers:test", custom: true },
								{
									urn: "urn:parented-stack",
									type: "pulumi:pulumi:Stack",
									custom: false,
									parent: "urn:parent",
									outputs: { endpoint: "https://wrong.example.test" },
								},
								{
									urn: "urn:pulumi:dev::myproj::pulumi:pulumi:Stack::myproj-dev",
									type: "pulumi:pulumi:Stack",
									custom: false,
									outputs: { endpoint: "https://example.test", password: { ciphertext: "secret" } },
								},
							],
						},
					}) as never,
			),
		});
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		app.get("/stacks/:org/:project/:stack/outputs", stateHandlers(updates, stacks).stackOutputs);

		const res = await app.request("/stacks/myorg/myproj/dev/outputs");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			outputs: { endpoint: "https://example.test", password: { ciphertext: "secret" } },
			secretsProviders: { type: "passphrase", state: { salt: "salt" } },
		});
		expect(stacks.getStack).toHaveBeenCalledWith("t-1", "myorg", "myproj", "dev");
		expect(updates.exportStack).toHaveBeenCalledWith("stack-uuid-1");
	});

	test("stackOutputs omits fields when the stack has no state", async () => {
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		app.get(
			"/stacks/:org/:project/:stack/outputs",
			stateHandlers(mockUpdatesService(), mockStacksService()).stackOutputs,
		);

		const res = await app.request("/stacks/myorg/myproj/dev/outputs");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({});
	});

	test("exportStack with version passes parsed int to service", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = stateHandlers(updates, stacks);
		app.get("/stacks/:org/:project/:stack/export/:version", h.exportStack);

		const res = await app.request("/stacks/myorg/myproj/dev/export/7");
		expect(res.status).toBe(200);
		expect(updates.exportStack).toHaveBeenCalledWith("stack-uuid-1", 7);
	});

	test("exportStack rejects malformed and non-positive versions", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = stateHandlers(updates, stacks);
		app.get("/stacks/:org/:project/:stack/export/:version", h.exportStack);

		for (const version of ["0", "-1", "1.5", "7junk", "NaN", "9007199254740992"]) {
			const res = await app.request(`/stacks/myorg/myproj/dev/export/${version}`);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				code: "invalid_request",
				message: "Version must be a positive integer",
			});
		}
		expect(stacks.getStack).not.toHaveBeenCalled();
		expect(updates.exportStack).not.toHaveBeenCalled();
	});

	test("importStack returns updateID", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = stateHandlers(updates, stacks);
		app.post("/stacks/:org/:project/:stack/import", h.importStack);

		const deployment = { version: 3, deployment: { manifest: {}, resources: [] } };
		const res = await app.request("/stacks/myorg/myproj/dev/import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(deployment),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.updateID).toBe("import-1");
		expect(updates.importStack).toHaveBeenCalledWith("stack-uuid-1", deployment);
	});

	test("importStack rejects malformed deployments with 400", async () => {
		for (const body of [
			{ version: 3 },
			{ version: 3, deployment: { resources: "not-an-array" } },
			{ version: 3, deployment: { resources: {} } },
			{ version: 3, deployment: { resources: [null] } },
		]) {
			const updates = mockUpdatesService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = stateHandlers(updates, mockStacksService());
			app.post("/stacks/:org/:project/:stack/import", h.importStack);

			const res = await app.request("/stacks/myorg/myproj/dev/import", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			expect(res.status).toBe(400);
			expect(updates.importStack).not.toHaveBeenCalled();
		}
	});

	test("exportStack looks up stack by caller tenant", async () => {
		const stacks = mockStacksService();
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = stateHandlers(updates, stacks);
		app.get("/stacks/:org/:project/:stack/export", h.exportStack);

		await app.request("/stacks/myorg/myproj/dev/export");
		expect(stacks.getStack).toHaveBeenCalledWith("t-1", "myorg", "myproj", "dev");
	});
});
