// Stack-managed ESC environments (Pulumi CLI `stack init --esc-config`): stack create/delete,
// update environment pins, and the ESC routes the CLI uses to evaluate managed environments.

import { describe, expect, type Mock, mock, test } from "bun:test";
import {
	type EscService,
	MANAGED_ENVIRONMENT_PLACEHOLDER,
	type OpenSessionOptions,
} from "@procella/esc";
import type { StackInfo, StacksService } from "@procella/stacks";
import type { Caller } from "@procella/types";
import { ConflictError, NotFoundError } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import { Hono } from "hono";
import { errorHandler } from "../middleware/error-handler.js";
import type { Env } from "../types.js";
import { escHandlers } from "./esc.js";
import { stackHandlers } from "./stacks.js";
import { updateHandlers } from "./updates.js";

const caller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "u-1",
	login: "test-user",
	roles: ["admin"],
	principalType: "user",
};

const baseStack: StackInfo = {
	id: "stack-1",
	projectId: "proj-1",
	tenantId: "t-1",
	orgName: "t-1",
	projectName: "app",
	stackName: "dev",
	tags: {},
	activeUpdateId: null,
	managedEnvironment: null,
	lastUpdate: null,
	resourceCount: null,
	createdAt: new Date("2026-01-01"),
	updatedAt: new Date("2026-01-01"),
};

function stacksMock(overrides: Partial<StacksService> = {}): StacksService {
	return {
		createStack: mock(async (_t, _o, project, stack, _tags, options) => ({
			...baseStack,
			projectName: project,
			stackName: stack,
			managedEnvironment: options?.managedEnvironment ?? null,
		})),
		getStack: mock(async () => baseStack),
		listStacks: async () => [],
		deleteStack: mock(async () => {}),
		renameStack: async () => {},
		updateStackTags: async () => {},
		replaceStackTags: async () => {},
		getStackByFQN: async () => baseStack,
		getStackByNames_systemOnly: async () => baseStack,
		getStackById_systemOnly: async () => baseStack,
		...overrides,
	} as StacksService;
}

function escMock(overrides: Partial<EscService> = {}): EscService {
	return {
		createEnvironment: mock(async () => ({})),
		deleteEnvironment: mock(async () => {}),
		openSession: mock(async () => ({
			sessionId: "session-1",
			values: {},
			secrets: [],
			expiresAt: new Date(),
		})),
		getRevision: mock(async (_t: string, _p: string, _e: string, revisionNumber: number) => ({
			revisionNumber,
			yamlBody: "values: {}\n",
		})),
		encryptSecrets: mock(async (_t: string, _p: string, _e: string, plaintexts: Uint8Array[]) =>
			plaintexts.map((p) => `ct:${Buffer.from(p).toString()}`),
		),
		...overrides,
	} as unknown as EscService;
}

function appWith(register: (app: Hono<Env>) => void): Hono<Env> {
	const app = new Hono<Env>();
	app.onError(errorHandler());
	app.use("*", async (c, next) => {
		c.set("caller", caller);
		await next();
	});
	register(app);
	return app;
}

function post(app: Hono<Env>, path: string, body?: unknown) {
	return app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe("managed stack creation", () => {
	test("creates <project>/<stack> with the CLI placeholder and returns its name", async () => {
		const stacks = stacksMock();
		const esc = escMock();
		const app = appWith((a) =>
			a.post("/stacks/:org/:project", stackHandlers(stacks, esc).createStack),
		);

		const res = await post(app, "/stacks/my-org/app", {
			stackName: "dev",
			createManagedEnvironment: true,
		});

		expect(res.status).toBe(200);
		expect((await res.json()).managedEnvironment).toBe("app/dev");
		expect(stacks.createStack).toHaveBeenCalledWith("t-1", "my-org", "app", "dev", undefined, {
			managedEnvironment: "app/dev",
		});
		expect(esc.createEnvironment).toHaveBeenCalledWith(
			"t-1",
			{ projectName: "app", name: "dev", yamlBody: MANAGED_ENVIRONMENT_PLACEHOLDER },
			"u-1",
		);
	});

	test("placeholder matches the definition the Pulumi CLI writes to the stack file", () => {
		// pulumi/pkg/cmd/pulumi/stack/managed_env.go: managedEnvironmentPlaceholder
		expect(MANAGED_ENVIRONMENT_PLACEHOLDER.trimEnd()).toBe("values:\n  pulumiConfig: {}");
	});

	test("unmanaged creation does not touch ESC or include managedEnvironment", async () => {
		const stacks = stacksMock();
		const esc = escMock();
		const app = appWith((a) =>
			a.post("/stacks/:org/:project", stackHandlers(stacks, esc).createStack),
		);

		const res = await post(app, "/stacks/my-org/app", { stackName: "dev" });

		expect(res.status).toBe(200);
		expect(await res.json()).not.toHaveProperty("managedEnvironment");
		expect(esc.createEnvironment).not.toHaveBeenCalled();
	});

	test("rolls the stack back and returns 409 when the environment already exists", async () => {
		const stacks = stacksMock();
		const esc = escMock({
			createEnvironment: mock(async () => {
				throw new ConflictError("Environment app/dev already exists");
			}),
		});
		const app = appWith((a) =>
			a.post("/stacks/:org/:project", stackHandlers(stacks, esc).createStack),
		);

		const res = await post(app, "/stacks/my-org/app", {
			stackName: "dev",
			createManagedEnvironment: true,
		});

		expect(res.status).toBe(409);
		expect(stacks.deleteStack).toHaveBeenCalledWith("t-1", "my-org", "app", "dev", true);
	});

	test("rejects managed creation when the server has no ESC service", async () => {
		const stacks = stacksMock();
		const app = appWith((a) => a.post("/stacks/:org/:project", stackHandlers(stacks).createStack));

		const res = await post(app, "/stacks/my-org/app", {
			stackName: "dev",
			createManagedEnvironment: true,
		});

		expect(res.status).toBe(400);
		expect(stacks.createStack).not.toHaveBeenCalled();
	});
});

describe("managed stack reads and deletion", () => {
	test("getStack returns managedEnvironment", async () => {
		const stacks = stacksMock({
			getStack: mock(async () => ({ ...baseStack, managedEnvironment: "app/dev" })),
		});
		const app = appWith((a) =>
			a.get("/stacks/:org/:project/:stack", stackHandlers(stacks).getStack),
		);

		const res = await app.request("/stacks/my-org/app/dev");

		expect((await res.json()).managedEnvironment).toBe("app/dev");
	});

	test("deleting a managed stack deletes its environment after the stack", async () => {
		const order: string[] = [];
		const stacks = stacksMock({
			getStack: mock(async () => ({ ...baseStack, managedEnvironment: "app/dev" })),
			deleteStack: mock(async () => {
				order.push("stack");
			}),
		});
		const esc = escMock({
			deleteEnvironment: mock(async () => {
				order.push("env");
			}),
		});
		const app = appWith((a) =>
			a.delete("/stacks/:org/:project/:stack", stackHandlers(stacks, esc).deleteStack),
		);

		const res = await app.request("/stacks/my-org/app/dev", { method: "DELETE" });

		expect(res.status).toBe(204);
		expect(order).toEqual(["stack", "env"]);
		expect(esc.deleteEnvironment).toHaveBeenCalledWith("t-1", "app", "dev");
	});

	test("an already-deleted environment does not fail stack deletion", async () => {
		const stacks = stacksMock({
			getStack: mock(async () => ({ ...baseStack, managedEnvironment: "app/dev" })),
		});
		const esc = escMock({
			deleteEnvironment: mock(async () => {
				throw new NotFoundError("Environment", "app/dev");
			}),
		});
		const app = appWith((a) =>
			a.delete("/stacks/:org/:project/:stack", stackHandlers(stacks, esc).deleteStack),
		);

		expect((await app.request("/stacks/my-org/app/dev", { method: "DELETE" })).status).toBe(204);
	});

	test("deleting an unmanaged stack leaves ESC alone", async () => {
		const stacks = stacksMock();
		const esc = escMock();
		const app = appWith((a) =>
			a.delete("/stacks/:org/:project/:stack", stackHandlers(stacks, esc).deleteStack),
		);

		expect((await app.request("/stacks/my-org/app/dev", { method: "DELETE" })).status).toBe(204);
		expect(esc.deleteEnvironment).not.toHaveBeenCalled();
	});
});

describe("update environment pin", () => {
	function updatesMock() {
		return {
			createUpdate: mock(async () => ({ updateID: "u-1", requiredPolicies: [], messages: [] })),
		} as unknown as UpdatesService;
	}
	const path = "/stacks/:org/:project/:stack/:kind";

	test("forwards a valid pin to createUpdate", async () => {
		const updates = updatesMock();
		const app = appWith((a) => a.post(path, updateHandlers(updates, stacksMock()).createUpdate));
		const environment = { baseRevision: 3, changeRequestID: "cr-1", draftRevision: 0 };

		const res = await post(app, "/stacks/my-org/app/dev/update", { environment });

		expect(res.status).toBe(200);
		expect(updates.createUpdate).toHaveBeenCalledWith(
			"stack-1",
			"update",
			undefined,
			undefined,
			caller,
			undefined,
			{ managedEnvironment: environment },
		);
	});

	test("omits options when the request has no pin", async () => {
		const updates = updatesMock();
		const app = appWith((a) => a.post(path, updateHandlers(updates, stacksMock()).createUpdate));

		await post(app, "/stacks/my-org/app/dev/update", {});

		expect(
			(updates.createUpdate as Mock<(...args: unknown[]) => unknown>).mock.calls[0]?.[6],
		).toBeUndefined();
	});

	test.each([
		[{ baseRevision: -1, draftRevision: 0 }],
		[{ baseRevision: 1.5, draftRevision: 0 }],
		[{ baseRevision: 1 }],
		[{ baseRevision: 1, draftRevision: 0, extra: true }],
		["r1"],
	])("rejects malformed pin %p", async (environment) => {
		const updates = updatesMock();
		const app = appWith((a) => a.post(path, updateHandlers(updates, stacksMock()).createUpdate));

		const res = await post(app, "/stacks/my-org/app/dev/update", { environment });

		expect(res.status).toBe(400);
		expect(updates.createUpdate).not.toHaveBeenCalled();
	});
});

describe("ESC routes used by managed stacks", () => {
	const env = "/esc/environments/:org/:project/:envName";
	function escApp(esc: EscService) {
		const h = escHandlers({ esc, resolveUserDisplayName: async () => null });
		return appWith((a) => {
			a.post(`${env}/open`, h.openSession);
			a.post(`${env}/versions/:version/open`, h.openSession);
			a.post(`${env}/drafts/:draftId/open`, h.openDraftSession);
			a.post(`${env}/encrypt-secrets`, h.encryptSecrets);
		});
	}
	const openOptions = (esc: EscService) =>
		(esc.openSession as Mock<(...args: unknown[]) => unknown>).mock.calls[0]?.[3] as
			| OpenSessionOptions
			| undefined;

	test("opens a specific published revision", async () => {
		const esc = escMock();
		const res = await post(
			escApp(esc),
			"/esc/environments/my-org/app/dev/versions/4/open?duration=2h0m0s",
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ id: "session-1" });
		expect(openOptions(esc)).toEqual({ revision: 4 });
	});

	test("opening the latest revision passes no options", async () => {
		const esc = escMock();
		await post(escApp(esc), "/esc/environments/my-org/app/dev/open");
		expect(openOptions(esc)).toBeUndefined();
	});

	test("opens draft revision 0", async () => {
		const esc = escMock();
		const res = await post(
			escApp(esc),
			"/esc/environments/my-org/app/dev/drafts/cr-1/open?revision=0",
		);

		expect(res.status).toBe(200);
		expect(openOptions(esc)).toEqual({ draftId: "cr-1" });
	});

	test("rejects other draft revisions", async () => {
		const esc = escMock();
		const res = await post(
			escApp(esc),
			"/esc/environments/my-org/app/dev/drafts/cr-1/open?revision=2",
		);

		expect(res.status).toBe(400);
		expect(esc.openSession).not.toHaveBeenCalled();
	});

	test("encrypt-secrets decodes base64 plaintexts and returns ciphertexts in order", async () => {
		const esc = escMock();
		const plaintexts = ["a", "bc"].map((s) => Buffer.from(s).toString("base64"));

		const res = await post(escApp(esc), "/esc/environments/my-org/app/dev/encrypt-secrets", {
			plaintexts,
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ciphertexts: ["ct:a", "ct:bc"] });
	});

	test.each([
		[{}],
		[{ plaintexts: [] }],
		[{ plaintexts: ["not base64!"] }],
		[{ plaintexts: ["YQ=="], extra: 1 }],
	])("encrypt-secrets rejects %p", async (body) => {
		const esc = escMock();
		const res = await post(escApp(esc), "/esc/environments/my-org/app/dev/encrypt-secrets", body);

		expect(res.status).toBe(400);
		expect(esc.encryptSecrets).not.toHaveBeenCalled();
	});

	test("encrypt-secrets rejects another organization", async () => {
		const esc = escMock();
		const res = await post(escApp(esc), "/esc/environments/other-org/app/dev/encrypt-secrets", {
			plaintexts: ["YQ=="],
		});

		expect(res.status).toBe(400);
		expect(esc.encryptSecrets).not.toHaveBeenCalled();
	});
});
