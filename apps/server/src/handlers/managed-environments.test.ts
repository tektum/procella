// Stack-managed ESC environments (Pulumi CLI `stack init --esc-config`): stack create/delete,
// update environment pins, and the ESC routes the CLI uses to evaluate managed environments.

import { describe, expect, type Mock, mock, test } from "bun:test";
import type { Database } from "@procella/db";
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

/** Stand-in for the transaction object passed to `withinTransaction` hooks. */
const TX = { tx: true } as unknown as Database;

/**
 * Stacks service fake with transaction semantics: a stack is committed only if its
 * `withinTransaction` hook succeeds, and deletion runs the hook before removing the row.
 */
function stacksMock(overrides: Partial<StacksService> = {}) {
	const committed = new Map<string, StackInfo>();
	const service = {
		createStack: mock(async (_t, _o, project, stack, _tags, options) => {
			const info = {
				...baseStack,
				projectName: project,
				stackName: stack,
				managedEnvironment: options?.managedEnvironment ?? null,
			};
			await options?.withinTransaction?.(TX);
			committed.set(`${project}/${stack}`, info);
			return info;
		}),
		getStack: mock(async () => baseStack),
		listStacks: async () => [],
		deleteStack: mock(async (_t, _o, project, stack, _force, options) => {
			const info = committed.get(`${project}/${stack}`) ?? baseStack;
			await options?.withinTransaction?.(TX, {
				managedEnvironment: info.managedEnvironment ?? null,
			});
			committed.delete(`${project}/${stack}`);
		}),
		renameStack: async () => {},
		updateStackTags: async () => {},
		replaceStackTags: async () => {},
		getStackByFQN: async () => baseStack,
		getStackByNames_systemOnly: async () => baseStack,
		getStackById_systemOnly: async () => baseStack,
		...overrides,
	} as StacksService;
	return { service, committed };
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
	const createApp = (stacks: StacksService, esc?: EscService) =>
		appWith((a) => a.post("/stacks/:org/:project", stackHandlers(stacks, esc).createStack));

	test("creates <project>/<stack> in the stack's transaction and returns its name", async () => {
		const { service, committed } = stacksMock();
		const esc = escMock();

		const res = await post(createApp(service, esc), "/stacks/my-org/app", {
			stackName: "dev",
			createManagedEnvironment: true,
		});

		expect(res.status).toBe(200);
		expect((await res.json()).managedEnvironment).toBe("app/dev");
		expect(committed.get("app/dev")?.managedEnvironment).toBe("app/dev");
		expect(esc.createEnvironment).toHaveBeenCalledWith(
			"t-1",
			{ projectName: "app", name: "dev", yamlBody: MANAGED_ENVIRONMENT_PLACEHOLDER },
			"u-1",
			{ tx: TX },
		);
	});

	test("placeholder matches the definition the Pulumi CLI writes to the stack file", () => {
		// pulumi/pkg/cmd/pulumi/stack/managed_env.go: managedEnvironmentPlaceholder
		expect(MANAGED_ENVIRONMENT_PLACEHOLDER.trimEnd()).toBe("values:\n  pulumiConfig: {}");
	});

	test("unmanaged creation does not touch ESC or include managedEnvironment", async () => {
		const { service } = stacksMock();
		const esc = escMock();

		const res = await post(createApp(service, esc), "/stacks/my-org/app", { stackName: "dev" });

		expect(res.status).toBe(200);
		expect(await res.json()).not.toHaveProperty("managedEnvironment");
		expect(esc.createEnvironment).not.toHaveBeenCalled();
	});

	test("an existing environment fails the request with 409 and commits no stack", async () => {
		const { service, committed } = stacksMock();
		const esc = escMock({
			createEnvironment: mock(async () => {
				throw new ConflictError("Environment app/dev already exists");
			}),
		});

		const res = await post(createApp(service, esc), "/stacks/my-org/app", {
			stackName: "dev",
			createManagedEnvironment: true,
		});

		expect(res.status).toBe(409);
		expect(committed.size).toBe(0);
		expect(service.deleteStack).not.toHaveBeenCalled();
	});

	test("rejects managed creation when the server has no ESC service", async () => {
		const { service } = stacksMock();

		const res = await post(createApp(service), "/stacks/my-org/app", {
			stackName: "dev",
			createManagedEnvironment: true,
		});

		expect(res.status).toBe(400);
		expect(service.createStack).not.toHaveBeenCalled();
	});
});

describe("managed stack reads and deletion", () => {
	const deleteApp = (stacks: StacksService, esc?: EscService) =>
		appWith((a) =>
			a.delete("/stacks/:org/:project/:stack", stackHandlers(stacks, esc).deleteStack),
		);
	const managed = () => {
		const mocks = stacksMock();
		mocks.committed.set("app/dev", { ...baseStack, managedEnvironment: "app/dev" });
		return mocks;
	};

	test("getStack returns managedEnvironment", async () => {
		const { service } = stacksMock({
			getStack: mock(async () => ({ ...baseStack, managedEnvironment: "app/dev" })),
		});
		const app = appWith((a) =>
			a.get("/stacks/:org/:project/:stack", stackHandlers(service).getStack),
		);

		const res = await app.request("/stacks/my-org/app/dev");

		expect((await res.json()).managedEnvironment).toBe("app/dev");
	});

	test("deletes the environment in the stack's deletion transaction", async () => {
		const { service, committed } = managed();
		const esc = escMock();

		const res = await deleteApp(service, esc).request("/stacks/my-org/app/dev", {
			method: "DELETE",
		});

		expect(res.status).toBe(204);
		expect(committed.has("app/dev")).toBe(false);
		expect(esc.deleteEnvironment).toHaveBeenCalledWith("t-1", "app", "dev", { tx: TX });
	});

	test("an already-deleted environment does not fail stack deletion", async () => {
		const { service, committed } = managed();
		const esc = escMock({
			deleteEnvironment: mock(async () => {
				throw new NotFoundError("Environment", "app/dev");
			}),
		});

		const res = await deleteApp(service, esc).request("/stacks/my-org/app/dev", {
			method: "DELETE",
		});

		expect(res.status).toBe(204);
		expect(committed.has("app/dev")).toBe(false);
	});

	test("a failed environment deletion aborts the stack deletion", async () => {
		const { service, committed } = managed();
		const esc = escMock({
			deleteEnvironment: mock(async () => {
				throw new Error("db down");
			}),
		});

		const res = await deleteApp(service, esc).request("/stacks/my-org/app/dev", {
			method: "DELETE",
		});

		expect(res.status).toBe(500);
		expect(committed.has("app/dev")).toBe(true);
	});

	test("deleting an unmanaged stack leaves ESC alone", async () => {
		const { service } = stacksMock();
		const esc = escMock();

		expect(
			(await deleteApp(service, esc).request("/stacks/my-org/app/dev", { method: "DELETE" }))
				.status,
		).toBe(204);
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
		const app = appWith((a) =>
			a.post(path, updateHandlers(updates, stacksMock().service).createUpdate),
		);
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
		const app = appWith((a) =>
			a.post(path, updateHandlers(updates, stacksMock().service).createUpdate),
		);

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
		const app = appWith((a) =>
			a.post(path, updateHandlers(updates, stacksMock().service).createUpdate),
		);

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
