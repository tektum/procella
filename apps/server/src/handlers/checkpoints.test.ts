import { describe, expect, mock, test } from "bun:test";
import { gzipSync } from "node:zlib";
import type { UpdatesService } from "@procella/updates";
import { Hono } from "hono";
import { decompress } from "../middleware/decompress.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { Env } from "../types.js";
import { checkpointHandlers } from "./checkpoints.js";

function mockUpdatesService(overrides?: Partial<UpdatesService>): UpdatesService {
	return {
		createUpdate: mock(async () => ({ updateID: "", requiredPolicies: [] }) as never),
		startUpdate: mock(async () => ({}) as never),
		completeUpdate: mock(async () => {}),
		getUpdateContext: mock(async () => ({ stackId: "s-1", environment: {} })),
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

describe("checkpointHandlers", () => {
	test("patchCheckpoint calls service and returns 200", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectUpdateContext("u-1", "s-1"));
		const h = checkpointHandlers(updates);
		app.patch("/checkpoint", h.patchCheckpoint);

		const body = { isInvalid: false, version: 1, deployment: { resources: [] } };
		const res = await app.request("/checkpoint", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		expect(res.status).toBe(200);
		expect(updates.patchCheckpoint).toHaveBeenCalledTimes(1);
		expect(updates.patchCheckpoint).toHaveBeenCalledWith("u-1", body);
	});

	test("patchCheckpoint returns 400 (not 500) on malformed JSON (PR #149 review — JSON.parse failure must surface as invalid_request)", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectUpdateContext("u-1", "s-1"));
		const h = checkpointHandlers(updates);
		app.patch("/checkpoint", h.patchCheckpoint);

		const res = await app.request("/checkpoint", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: "{ this is not valid json",
		});

		expect(res.status).toBe(400);
		const json = (await res.json()) as { code: string };
		expect(json.code).toBe("invalid_request");
		expect(updates.patchCheckpoint).not.toHaveBeenCalled();
	});

	test("patchCheckpointVerbatim returns 400 on malformed JSON", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectUpdateContext("u-2", "s-2"));
		const h = checkpointHandlers(updates);
		app.patch("/checkpointverbatim", h.patchCheckpointVerbatim);

		const res = await app.request("/checkpointverbatim", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: "not json at all",
		});

		expect(res.status).toBe(400);
	});

	test("patchCheckpointVerbatim forwards the exact untypedDeployment source text", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectUpdateContext("u-2", "s-2"));
		const h = checkpointHandlers(updates);
		app.patch("/checkpointverbatim", h.patchCheckpointVerbatim);

		// Hand-written body: key order and the `1.0` / `1e30` literals do not survive
		// JSON.parse + JSON.stringify, and the CLI diffs against exactly these bytes.
		const untypedDeployment = '{"version":3,"deployment":{"z":1,"a":1.0,"n":1e30}}';
		const body = `{"version":2,"untypedDeployment":${untypedDeployment},"sequenceNumber":1}`;
		const res = await app.request("/checkpointverbatim", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body,
		});

		expect(res.status).toBe(200);
		expect(updates.patchCheckpointVerbatim).toHaveBeenCalledTimes(1);
		expect(updates.patchCheckpointVerbatim).toHaveBeenCalledWith("u-2", {
			version: 2,
			sequenceNumber: 1,
			untypedDeploymentText: untypedDeployment,
		});
	});

	test("patchCheckpointVerbatim preserves bytes through the gzip decompress middleware", async () => {
		// The Pulumi CLI sends checkpoints with Content-Encoding: gzip.
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", decompress());
		app.use("*", injectUpdateContext("u-2", "s-2"));
		const h = checkpointHandlers(updates);
		app.patch("/checkpointverbatim", h.patchCheckpointVerbatim);

		const untypedDeployment = '{"version":3,"deployment":{"z":1,"a":1.0,"n":1e30}}';
		const body = `{"version":3,"untypedDeployment":${untypedDeployment},"sequenceNumber":1}`;
		const res = await app.request("/checkpointverbatim", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
			body: gzipSync(Buffer.from(body)),
		});

		expect(res.status).toBe(200);
		expect(updates.patchCheckpointVerbatim).toHaveBeenCalledWith("u-2", {
			version: 3,
			sequenceNumber: 1,
			untypedDeploymentText: untypedDeployment,
		});
	});

	test("patchCheckpointVerbatim rejects schema v4 and non-empty features", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectUpdateContext("u-2", "s-2"));
		const h = checkpointHandlers(updates);
		app.patch("/checkpointverbatim", h.patchCheckpointVerbatim);

		const res = await app.request("/checkpointverbatim", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				version: 4,
				sequenceNumber: 1,
				untypedDeployment: { version: 4, deployment: {} },
			}),
		});

		expect(res.status).toBe(400);
		expect(updates.patchCheckpointVerbatim).not.toHaveBeenCalled();
	});

	test("patchCheckpointVerbatim requires untypedDeployment", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectUpdateContext("u-2", "s-2"));
		const h = checkpointHandlers(updates);
		app.patch("/checkpointverbatim", h.patchCheckpointVerbatim);

		const res = await app.request("/checkpointverbatim", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ version: 3, sequenceNumber: 1 }),
		});

		expect(res.status).toBe(400);
		expect(updates.patchCheckpointVerbatim).not.toHaveBeenCalled();
	});

	test("patchCheckpointDelta calls service and returns 200", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectUpdateContext("u-3", "s-3"));
		const h = checkpointHandlers(updates);
		app.patch("/checkpointdelta", h.patchCheckpointDelta);

		const checkpointHash = "a".repeat(64);
		const deploymentDelta = [
			{ span: { start: { offset: 0 }, end: { offset: 5 } }, newText: "hello" },
		];
		const res = await app.request("/checkpointdelta", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ version: 3, sequenceNumber: 1, checkpointHash, deploymentDelta }),
		});

		expect(res.status).toBe(200);
		expect(updates.patchCheckpointDelta).toHaveBeenCalledTimes(1);
		expect(updates.patchCheckpointDelta).toHaveBeenCalledWith("u-3", {
			version: 3,
			sequenceNumber: 1,
			checkpointHash,
			deploymentDelta: [{ span: { start: { offset: 0 }, end: { offset: 5 } }, newText: "hello" }],
		});
	});

	test("patchCheckpointDelta rejects a missing or non-SHA-256 checkpointHash", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectUpdateContext("u-3", "s-3"));
		const h = checkpointHandlers(updates);
		app.patch("/checkpointdelta", h.patchCheckpointDelta);

		const deploymentDelta = [{ span: { start: { offset: 0 }, end: { offset: 0 } }, newText: "x" }];
		for (const checkpointHash of [undefined, "", "abc123"]) {
			const res = await app.request("/checkpointdelta", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ version: 3, sequenceNumber: 1, checkpointHash, deploymentDelta }),
			});
			expect(res.status).toBe(400);
		}
		expect(updates.patchCheckpointDelta).not.toHaveBeenCalled();
	});

	test("appendJournalEntries calls service and returns 200", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectUpdateContext("u-4", "s-4"));
		const h = checkpointHandlers(updates);
		app.patch("/journal", h.appendJournalEntries);

		const body = { entries: [{ version: 1, kind: 1, operationID: 1, sequenceID: 1 }] };
		const res = await app.request("/journal", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		expect(res.status).toBe(200);
		expect(updates.appendJournalEntries).toHaveBeenCalledTimes(1);
		expect(updates.appendJournalEntries).toHaveBeenCalledWith("u-4", body);
	});

	test("handlers throw when updateContext is not set", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.onError(errorHandler());
		const h = checkpointHandlers(updates);
		app.patch("/checkpoint", h.patchCheckpoint);

		const res = await app.request("/checkpoint", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(400);
	});
});
