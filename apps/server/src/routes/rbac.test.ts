import { describe, expect, mock, test } from "bun:test";
import { PostgresNotificationHub } from "@procella/api/src/notifications.js";
import type { AuditService } from "@procella/audit";
import type { AuthService } from "@procella/auth";
import type { Database } from "@procella/db";
import type { EscService } from "@procella/esc";
import type { StackInfo, StacksService } from "@procella/stacks";
import type { Caller, Role } from "@procella/types";
import { UnauthorizedError } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import { type CliAppDeps, createCliApp } from "./cli.js";
import { createApp } from "./index.js";

const stackInfo: StackInfo = {
	id: "stack-1",
	projectId: "project-1",
	tenantId: "tenant-1",
	orgName: "my-org",
	projectName: "project",
	stackName: "stack",
	tags: {},
	activeUpdateId: null,
	lastUpdate: null,
	resourceCount: null,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const environment = {
	id: "environment-1",
	projectId: "project-1",
	name: "environment",
	yamlBody: "values: {}",
	currentRevisionNumber: 1,
	createdBy: "user-1",
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const draft = {
	id: "11111111-1111-1111-8111-111111111111",
	environmentId: environment.id,
	yamlBody: "values: {}",
	description: "draft",
	createdBy: "user-1",
	status: "open" as const,
	appliedRevisionId: null,
	appliedAt: null,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
};

interface ServiceTracker {
	calls: string[];
}

function callerFor(role: Role): Caller {
	return {
		tenantId: "tenant-1",
		orgSlug: "my-org",
		userId: "user-1",
		login: `${role}-user`,
		roles: [role],
		principalType: "user",
	};
}

function dependenciesFor(role: Role): { deps: CliAppDeps; tracker: ServiceTracker } {
	const tracker: ServiceTracker = { calls: [] };
	const called = (name: string) => tracker.calls.push(name);
	const auth: AuthService = {
		authenticate: mock(async (request: Request) => {
			if (request.headers.get("Authorization") !== `token ${role}-token`) {
				throw new UnauthorizedError("Invalid token");
			}
			return callerFor(role);
		}),
		createCliAccessKey: mock(async () => "unused"),
		authenticateUpdateToken: mock(async () => ({ updateId: "update-1", stackId: stackInfo.id })),
		resolveUserDisplayName: mock(async () => "Test User"),
	};
	const stacks = {
		createStack: mock(async () => {
			called("stacks.createStack");
			return stackInfo;
		}),
		getStack: mock(async () => {
			called("stacks.getStack");
			return stackInfo;
		}),
		listStacks: mock(async () => [stackInfo]),
		deleteStack: mock(async () => called("stacks.deleteStack")),
		renameStack: mock(async () => called("stacks.renameStack")),
		updateStackTags: mock(async () => called("stacks.updateStackTags")),
		replaceStackTags: mock(async () => called("stacks.replaceStackTags")),
		getStackByFQN: mock(async () => stackInfo),
		getStackByNames_systemOnly: mock(async () => stackInfo),
		getStackById_systemOnly: mock(async () => stackInfo),
	} as unknown as StacksService;
	const updates = {
		createUpdate: mock(async () => {
			called("updates.createUpdate");
			return { updateID: "update-1", requiredPolicies: [] };
		}),
		startUpdate: mock(async () => {
			called("updates.startUpdate");
			return { version: 1, token: "lease-token", tokenExpiration: Date.now() + 300_000 };
		}),
		completeUpdate: mock(async () => called("updates.completeUpdate")),
		cancelUpdate: mock(async () => called("updates.cancelUpdate")),
		patchCheckpoint: mock(async () => {}),
		patchCheckpointVerbatim: mock(async () => {}),
		patchCheckpointDelta: mock(async () => {}),
		postEvents: mock(async () => {}),
		renewLease: mock(async () => ({ token: "lease-token" })),
		getUpdate: mock(async () => ({ status: "succeeded", events: [], startTime: Date.now() })),
		getUpdateEvents: mock(async () => ({ events: [] })),
		getHistory: mock(async () => ({ updates: [] })),
		exportStack: mock(async () => ({ version: 3, deployment: {} })),
		importStack: mock(async () => {
			called("updates.importStack");
			return { updateID: "import-1" };
		}),
		encryptValue: mock(async () => {
			called("updates.encryptValue");
			return new Uint8Array([1]);
		}),
		decryptValue: mock(async () => {
			called("updates.decryptValue");
			return new Uint8Array([1]);
		}),
		batchEncrypt: mock(async () => {
			called("updates.batchEncrypt");
			return [new Uint8Array([1])];
		}),
		batchDecrypt: mock(async () => {
			called("updates.batchDecrypt");
			return [new Uint8Array([1])];
		}),
		verifyLeaseToken: mock(async () => {}),
		verifyUpdateOwnership: mock(async () => called("updates.verifyUpdateOwnership")),
	} as unknown as UpdatesService;
	const esc = {
		listProjects: mock(async () => []),
		listAllEnvironments: mock(async () => ({ environments: [], nextToken: "" })),
		createEnvironment: mock(async () => {
			called("esc.createEnvironment");
			return environment;
		}),
		cloneEnvironment: mock(async () => {
			called("esc.cloneEnvironment");
			return environment;
		}),
		listEnvironments: mock(async () => [environment]),
		getEnvironment: mock(async () => {
			called("esc.getEnvironment");
			return environment;
		}),
		updateEnvironment: mock(async () => {
			called("esc.updateEnvironment");
			return environment;
		}),
		deleteEnvironment: mock(async () => called("esc.deleteEnvironment")),
		listRevisions: mock(async () => []),
		getRevision: mock(async () => null),
		openSession: mock(async () => {
			called("esc.openSession");
			return { sessionId: "session-1", values: {}, secrets: [] };
		}),
		getSession: mock(async () => null),
		listRevisionTags: mock(async () => []),
		tagRevision: mock(async () => called("esc.tagRevision")),
		untagRevision: mock(async () => called("esc.untagRevision")),
		getEnvironmentTags: mock(async () => ({})),
		setEnvironmentTags: mock(async () => called("esc.setEnvironmentTags")),
		updateEnvironmentTags: mock(async () => called("esc.updateEnvironmentTags")),
		createDraft: mock(async () => {
			called("esc.createDraft");
			return draft;
		}),
		listDrafts: mock(async () => []),
		updateDraft: mock(async () => {
			called("esc.updateDraft");
			return draft;
		}),
		getDraft: mock(async () => {
			called("esc.getDraft");
			return draft;
		}),
		applyDraft: mock(async () => {
			called("esc.applyDraft");
			return { ...draft, status: "applied" as const };
		}),
		discardDraft: mock(async () => called("esc.discardDraft")),
		validateYaml: mock(async () => {
			called("esc.validateYaml");
			return { values: {}, diagnostics: [] };
		}),
		gcSweep: mock(async () => ({ closedCount: 0 })),
		encryptSecrets: mock(async (_t: string, _p: string, _e: string, plaintexts: Uint8Array[]) =>
			plaintexts.map(() => "ciphertext"),
		),
	} as unknown as EscService;
	const audit = {
		log: mock(() => {}),
		query: mock(async () => ({ entries: [], total: 0 })),
		export: mock(async () => []),
	} as unknown as AuditService;
	const webhooks: WebhooksService = {
		createWebhook: mock(async () => {
			throw new Error("not exercised by RBAC tests");
		}),
		listWebhooks: mock(async () => []),
		getWebhook: mock(async () => null),
		updateWebhook: mock(async () => {
			throw new Error("not exercised by RBAC tests");
		}),
		deleteWebhook: mock(async () => {}),
		listDeliveries: mock(async () => []),
		ping: mock(async () => {
			throw new Error("not exercised by RBAC tests");
		}),
	};

	return {
		deps: {
			auth,
			authConfig: {
				mode: "dev",
				token: "unused",
				userLogin: "test-user",
				orgLogin: "my-org",
			},
			audit,
			db: {
				execute: async () => ({ rows: [{ acquired: false }] }),
				transaction: async (callback: (tx: unknown) => unknown) => callback({}),
			} as unknown as Database,
			stacks,
			updates,
			webhooks,
			esc,
			github: null,
		},
		tracker,
	};
}

interface MutationCase {
	name: string;
	method: "POST" | "PUT" | "PATCH" | "DELETE";
	path: string;
	body?: string;
	expectedCall?: string;
}

const json = (value: unknown) => JSON.stringify(value);
const base = "/api/stacks/my-org/project/stack";
const escBase = "/api/esc/environments/my-org/project/environment";
const internalEscBase = "/api/esc/v1-internal/environments/my-org/project/environment";
const draftId = draft.id;

const mutationCases: MutationCase[] = [
	{
		name: "rename stack",
		method: "POST",
		path: `${base}/rename`,
		body: json({ newName: "renamed" }),
		expectedCall: "stacks.renameStack",
	},
	{
		name: "update stack tags",
		method: "PATCH",
		path: `${base}/tags`,
		body: json({ team: "platform" }),
		expectedCall: "stacks.updateStackTags",
	},
	{
		name: "start update",
		method: "POST",
		path: `${base}/update/update-1`,
		body: json({}),
		expectedCall: "updates.startUpdate",
	},
	{
		name: "cancel update",
		method: "POST",
		path: `${base}/update/update-1/cancel`,
		expectedCall: "updates.cancelUpdate",
	},
	{
		name: "import state",
		method: "POST",
		path: `${base}/import`,
		body: json({ version: 3, deployment: {} }),
		expectedCall: "updates.importStack",
	},
	{
		name: "encrypt value",
		method: "POST",
		path: `${base}/encrypt`,
		body: json({ plaintext: "YQ==" }),
		expectedCall: "updates.encryptValue",
	},
	{
		name: "decrypt value",
		method: "POST",
		path: `${base}/decrypt`,
		body: json({ ciphertext: "YQ==" }),
		expectedCall: "updates.decryptValue",
	},
	{
		name: "batch encrypt",
		method: "POST",
		path: `${base}/batch-encrypt`,
		body: json({ plaintexts: ["YQ=="] }),
		expectedCall: "updates.batchEncrypt",
	},
	{
		name: "batch decrypt",
		method: "POST",
		path: `${base}/batch-decrypt`,
		body: json({ ciphertexts: ["YQ=="] }),
		expectedCall: "updates.batchDecrypt",
	},
	{ name: "log decryption", method: "POST", path: `${base}/log-decryption` },
	{
		name: "create update",
		method: "POST",
		path: `${base}/update`,
		body: json({}),
		expectedCall: "updates.createUpdate",
	},
	{
		name: "create named stack",
		method: "POST",
		path: base,
		body: json({}),
		expectedCall: "stacks.createStack",
	},
	{ name: "delete stack", method: "DELETE", path: base, expectedCall: "stacks.deleteStack" },
	{
		name: "create stack from body",
		method: "POST",
		path: "/api/stacks/my-org/project",
		body: json({ stackName: "stack" }),
		expectedCall: "stacks.createStack",
	},
	{
		name: "create environment",
		method: "POST",
		path: "/api/esc/environments/my-org",
		body: json({ project: "project", name: "environment" }),
		expectedCall: "esc.createEnvironment",
	},
	{
		name: "clone environment",
		method: "POST",
		path: `${escBase}/clone`,
		body: json({ project: "project", name: "clone" }),
		expectedCall: "esc.cloneEnvironment",
	},
	{
		name: "update environment",
		method: "PATCH",
		path: escBase,
		body: "values: {}",
		expectedCall: "esc.updateEnvironment",
	},
	{
		name: "delete environment",
		method: "DELETE",
		path: escBase,
		expectedCall: "esc.deleteEnvironment",
	},
	{
		name: "create revision tag",
		method: "POST",
		path: `${escBase}/versions/tags`,
		body: json({ name: "stable" }),
		expectedCall: "esc.tagRevision",
	},
	{
		name: "update revision tag",
		method: "PATCH",
		path: `${escBase}/versions/tags/stable`,
		body: json({ revision: 1 }),
		expectedCall: "esc.tagRevision",
	},
	{
		name: "delete revision tag",
		method: "DELETE",
		path: `${escBase}/versions/tags/stable`,
		expectedCall: "esc.untagRevision",
	},
	{
		name: "validate environment YAML",
		method: "POST",
		path: "/api/esc/environments/my-org/yaml/check",
		body: "values: {}",
		expectedCall: "esc.validateYaml",
	},
	{
		name: "open environment",
		method: "POST",
		path: `${escBase}/open`,
		expectedCall: "esc.openSession",
	},
	{
		name: "create environment draft",
		method: "POST",
		path: `${escBase}/drafts`,
		body: "values: {}",
		expectedCall: "esc.createDraft",
	},
	{
		name: "update environment draft",
		method: "PATCH",
		path: `${escBase}/drafts/${draftId}`,
		body: "values: {}",
		expectedCall: "esc.updateDraft",
	},
	{
		name: "create internal environment",
		method: "POST",
		path: "/api/esc/v1-internal/environments/my-org/project",
		body: json({ name: "environment", yamlBody: "values: {}" }),
		expectedCall: "esc.createEnvironment",
	},
	{
		name: "update internal environment",
		method: "PATCH",
		path: internalEscBase,
		body: json({ yamlBody: "values: {}" }),
		expectedCall: "esc.updateEnvironment",
	},
	{
		name: "delete internal environment",
		method: "DELETE",
		path: internalEscBase,
		expectedCall: "esc.deleteEnvironment",
	},
	{
		name: "delete internal revision tag",
		method: "DELETE",
		path: `${internalEscBase}/versions/tags/stable`,
		expectedCall: "esc.untagRevision",
	},
	{
		name: "tag internal revision",
		method: "PUT",
		path: `${internalEscBase}/versions/1/tags/stable`,
		expectedCall: "esc.tagRevision",
	},
	{
		name: "open internal environment",
		method: "POST",
		path: `${internalEscBase}/open`,
		expectedCall: "esc.openSession",
	},
	{
		name: "replace environment tags",
		method: "PUT",
		path: `${internalEscBase}/tags`,
		body: json({ team: "platform" }),
		expectedCall: "esc.setEnvironmentTags",
	},
	{
		name: "patch environment tags",
		method: "PATCH",
		path: `${internalEscBase}/tags`,
		body: json({ team: "platform" }),
		expectedCall: "esc.updateEnvironmentTags",
	},
	{
		name: "create internal draft",
		method: "POST",
		path: `${internalEscBase}/drafts`,
		body: json({ yamlBody: "values: {}", description: "draft" }),
		expectedCall: "esc.createDraft",
	},
	{
		name: "apply internal draft",
		method: "POST",
		path: `${internalEscBase}/drafts/${draftId}/apply`,
		expectedCall: "esc.applyDraft",
	},
	{
		name: "discard internal draft",
		method: "POST",
		path: `${internalEscBase}/drafts/${draftId}/discard`,
		expectedCall: "esc.discardDraft",
	},
];

const appFactories = [
	{
		name: "web",
		create: (deps: CliAppDeps) =>
			createApp({
				...deps,
				notifications: new PostgresNotificationHub({
					connectionString: "postgres://test:test@example.invalid/test",
				}),
				storage: {
					get: async () => null,
					put: async () => {},
					delete: async () => {},
					exists: async () => false,
				},
			}),
	},
	{ name: "cli", create: (deps: CliAppDeps) => createCliApp(deps) },
] as const;

describe("REST mutation RBAC", () => {
	for (const appFactory of appFactories) {
		for (const mutation of mutationCases) {
			for (const role of ["viewer", "member", "admin"] as const) {
				test(`${appFactory.name}: ${mutation.name} as ${role}`, async () => {
					const { deps, tracker } = dependenciesFor(role);
					const app = appFactory.create(deps);
					const response = await app.request(mutation.path, {
						method: mutation.method,
						headers: {
							Authorization: `token ${role}-token`,
							Accept: "application/vnd.pulumi+9",
							...(mutation.body === undefined ? {} : { "Content-Type": "application/json" }),
						},
						body: mutation.body,
					});
					const allowed = role === "admin" || (role === "member" && mutation.method !== "DELETE");

					if (!allowed) {
						expect(response.status).toBe(403);
						expect(tracker.calls).toEqual([]);
						return;
					}

					expect(response.status).toBeLessThan(400);
					if (mutation.expectedCall) {
						expect(tracker.calls).toContain(mutation.expectedCall);
					}
				});
			}
		}
	}
});

describe("REST method-role dispatch", () => {
	for (const appFactory of appFactories) {
		test(`${appFactory.name}: prototype-named methods fall through safely`, async () => {
			const { deps, tracker } = dependenciesFor("viewer");
			const response = await appFactory.create(deps).request(`${base}/unknown`, {
				method: "constructor",
				headers: { Authorization: "token viewer-token" },
			});

			expect(response.status).toBe(404);
			expect(tracker.calls).toEqual([]);
		});
	}
});
