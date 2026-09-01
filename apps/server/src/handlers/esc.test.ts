import { describe, expect, mock, test } from "bun:test";
import type {
	EscDraft,
	EscEnvironment,
	EscEnvironmentRevision,
	EscService,
	ListAllEnvironmentsResult,
	OpenSessionResult,
	ValidateYamlResult,
} from "@procella/esc";
import type { Caller } from "@procella/types";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { escHandlers } from "./esc.js";

const validCaller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "u-1",
	login: "test-user",
	roles: ["admin"],
	principalType: "user",
};

const now = new Date("2025-01-01T00:00:00.000Z");

const mockEnv: EscEnvironment = {
	id: "env-1",
	projectId: "proj-1",
	name: "staging",
	yamlBody: "values:\n  greeting: hello\n",
	currentRevisionNumber: 3,
	createdBy: "u-1",
	createdAt: now,
	updatedAt: now,
};

const mockRevision: EscEnvironmentRevision = {
	id: "rev-3",
	environmentId: "env-1",
	revisionNumber: 3,
	yamlBody: mockEnv.yamlBody,
	createdBy: "u-1",
	createdAt: now,
};

const mockDraft: EscDraft = {
	id: "draft-1",
	environmentId: "env-1",
	yamlBody: "values:\n  greeting: updated\n",
	description: "test draft",
	createdBy: "u-1",
	status: "open",
	appliedRevisionId: null,
	appliedAt: null,
	createdAt: now,
	updatedAt: now,
};

const mockSession: OpenSessionResult = {
	sessionId: "sess-1",
	values: { greeting: "hello", nested: { value: 42 } },
	secrets: ["nested.value"],
	expiresAt: new Date("2025-01-02T00:00:00.000Z"),
};

const mockValidation: ValidateYamlResult = {
	values: { greeting: "hello" },
	diagnostics: [],
};

const mockListAll: ListAllEnvironmentsResult = {
	environments: [{ organization: "my-org", project: "proj", name: "staging" }],
	nextToken: "",
};

function mockEscService(overrides?: Partial<EscService>): EscService {
	return {
		listProjects: mock(async () => []),
		listAllEnvironments: mock(async () => mockListAll),
		createEnvironment: mock(async () => mockEnv),
		cloneEnvironment: mock(async () => mockEnv),
		listEnvironments: mock(async () => [mockEnv]),
		getEnvironment: mock(async () => mockEnv),
		updateEnvironment: mock(async () => mockEnv),
		deleteEnvironment: mock(async () => {}),
		listRevisions: mock(async () => [mockRevision]),
		getRevision: mock(async () => mockRevision),
		openSession: mock(async () => mockSession),
		getSession: mock(async () => mockSession),
		listRevisionTags: mock(async () => []),
		tagRevision: mock(async () => {}),
		untagRevision: mock(async () => {}),
		getEnvironmentTags: mock(async () => ({})),
		setEnvironmentTags: mock(async () => {}),
		updateEnvironmentTags: mock(async () => {}),
		createDraft: mock(async () => mockDraft),
		listDrafts: mock(async () => [mockDraft]),
		updateDraft: mock(async () => mockDraft),
		getDraft: mock(async () => mockDraft),
		applyDraft: mock(async () => ({ ...mockDraft, status: "applied" as const })),
		discardDraft: mock(async () => {}),
		validateYaml: mock(async () => mockValidation),
		gcSweep: mock(async () => ({ closedCount: 0 })),
		...overrides,
	};
}

function injectCaller(caller: Caller) {
	return async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
		c.set("caller", caller);
		await next();
	};
}

function createTestApp(
	esc: EscService,
	resolveUserDisplayName: (subject: string) => Promise<string | null> = async (subject) =>
		subject === "u-1" ? "owner@example.com" : null,
) {
	const app = new Hono<Env>();
	app.use("*", injectCaller(validCaller));
	app.onError((err, c) => {
		const status =
			"statusCode" in err && typeof err.statusCode === "number"
				? err.statusCode
				: err.message.includes("not found")
					? 404
					: err.message.includes("does not match")
						? 400
						: 500;
		return c.json({ error: err.message }, status as 400 | 404 | 500);
	});

	const h = escHandlers({ esc, resolveUserDisplayName });
	app.get("/esc/environments", h.listAllEnvironments);
	app.get("/esc/environments/:org", h.listOrgEnvironments);
	app.post("/esc/environments/:org", h.createEnvironment);
	app.post("/esc/environments/:org/:project/:envName/clone", h.cloneEnvironment);
	app.get("/esc/environments/:org/:project/:envName", h.getEnvironment);
	app.get("/esc/environments/:org/:project/:envName/versions/:version", h.getEnvironment);
	app.patch("/esc/environments/:org/:project/:envName", h.updateEnvironment);
	app.delete("/esc/environments/:org/:project/:envName", h.deleteEnvironment);
	app.get("/esc/environments/:org/:project/:envName/versions", h.listRevisions);
	app.get("/esc/environments/:org/:project/:envName/versions/tags", h.listRevisionTags);
	app.post("/esc/environments/:org/:project/:envName/versions/tags", h.createRevisionTag);
	app.get("/esc/environments/:org/:project/:envName/versions/tags/:tagName", h.getRevisionTag);
	app.patch("/esc/environments/:org/:project/:envName/versions/tags/:tagName", h.updateRevisionTag);
	app.delete(
		"/esc/environments/:org/:project/:envName/versions/tags/:tagName",
		h.deleteRevisionTag,
	);
	app.post("/esc/environments/:org/yaml/check", h.validateYaml);
	app.post("/esc/environments/:org/:project/:envName/open", h.openSession);
	app.get("/esc/environments/:org/:project/:envName/open/:sessionId", h.getSession);
	app.post("/esc/environments/:org/:project/:envName/drafts", h.createDraft);
	app.get("/esc/environments/:org/:project/:envName/drafts/:draftId", h.getDraft);
	app.patch("/esc/environments/:org/:project/:envName/drafts/:draftId", h.updateDraft);

	app.get("/esc/v1-internal/environments/:org/:project/:envName", h.internalGetEnvironment);
	app.patch("/esc/v1-internal/environments/:org/:project/:envName", h.internalUpdateEnvironment);

	return app;
}

describe("escHandlers", () => {
	test("listAllEnvironments returns CLI environment summaries", async () => {
		const esc = mockEscService();
		const app = createTestApp(esc);

		const res = await app.request("/esc/environments?projectFilter=proj&continuationToken=after");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(mockListAll);
		expect(esc.listAllEnvironments).toHaveBeenCalledWith("t-1", {
			orgFilter: "my-org",
			projectFilter: "proj",
			after: "after",
		});
	});

	test("revision and tag responses never expose stored creator subjects", async () => {
		const esc = mockEscService({
			listRevisions: mock(async () => [{ ...mockRevision, createdBy: "K3-key" }]),
			listRevisionTags: mock(async () => [
				{ name: "stable", revisionNumber: 3, createdBy: "K3-key", createdAt: now },
			]),
		});
		const app = createTestApp(esc, async (subject) =>
			subject === "K3-key" ? "owner@example.com" : null,
		);

		const revisions = await app.request("/esc/environments/my-org/proj/staging/versions");
		const revisionBody = await revisions.json();
		expect(revisionBody).toEqual([
			expect.objectContaining({
				creatorLogin: "owner@example.com",
				creatorName: "owner@example.com",
			}),
		]);

		const tag = await app.request("/esc/environments/my-org/proj/staging/versions/tags/stable");
		const tagBody = await tag.json();
		expect(tagBody).toEqual(
			expect.objectContaining({
				editorLogin: "owner@example.com",
				editorName: "owner@example.com",
			}),
		);
		expect(JSON.stringify([revisionBody, tagBody])).not.toContain("K3-key");
	});

	test("revision responses use a safe label when identity lookup fails", async () => {
		const esc = mockEscService({
			listRevisions: mock(async () => [{ ...mockRevision, createdBy: "K3-key" }]),
		});
		const app = createTestApp(esc, async () => null);

		const response = await app.request("/esc/environments/my-org/proj/staging/versions");
		const body = await response.json();

		expect(body).toEqual([
			expect.objectContaining({ creatorLogin: "Unknown user", creatorName: "Unknown user" }),
		]);
		expect(JSON.stringify(body)).not.toContain("K3-key");
	});

	test("bounds concurrent creator lookups in revision responses", async () => {
		const revisions = Array.from({ length: 20 }, (_, index) => ({
			...mockRevision,
			id: `rev-${index}`,
			revisionNumber: index + 1,
			createdBy: `K3-key-${index}`,
		}));
		let activeLookups = 0;
		let maxActiveLookups = 0;
		const resolveUserDisplayName = mock(async (subject: string) => {
			activeLookups += 1;
			maxActiveLookups = Math.max(maxActiveLookups, activeLookups);
			await Promise.resolve();
			activeLookups -= 1;
			return `owner-${subject.slice("K3-key-".length)}@example.com`;
		});
		const app = createTestApp(
			mockEscService({ listRevisions: mock(async () => revisions) }),
			resolveUserDisplayName,
		);

		const response = await app.request("/esc/environments/my-org/proj/staging/versions");
		const body = await response.json();

		expect(body).toHaveLength(20);
		expect(resolveUserDisplayName).toHaveBeenCalledTimes(20);
		expect(maxActiveLookups).toBeLessThanOrEqual(8);
		expect(JSON.stringify(body)).not.toContain('"K3-key-');
	});
	test("listOrgEnvironments enforces org match", async () => {
		const esc = mockEscService();
		const app = createTestApp(esc);

		const ok = await app.request("/esc/environments/my-org?projectFilter=proj");
		expect(ok.status).toBe(200);
		expect(esc.listAllEnvironments).toHaveBeenCalledWith("t-1", {
			orgFilter: "my-org",
			projectFilter: "proj",
			after: undefined,
		});

		const bad = await app.request("/esc/environments/wrong-org");
		expect(bad.status).toBe(400);
	});

	test("createEnvironment accepts project in body and returns 201 with no body", async () => {
		const esc = mockEscService();
		const app = createTestApp(esc);

		const res = await app.request("/esc/environments/my-org", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ project: "proj", name: "staging" }),
		});
		expect(res.status).toBe(201);
		expect(await res.text()).toBe("");
		expect(esc.createEnvironment).toHaveBeenCalledWith(
			"t-1",
			{ projectName: "proj", name: "staging", yamlBody: "" },
			"u-1",
		);
	});

	test("cloneEnvironment forwards source path and destination body", async () => {
		const esc = mockEscService();
		const app = createTestApp(esc);

		const res = await app.request("/esc/environments/my-org/source-proj/source-env/clone", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ project: "dest-proj", name: "dest-env" }),
		});
		expect(res.status).toBe(201);
		expect(esc.cloneEnvironment).toHaveBeenCalledWith(
			"t-1",
			"source-proj",
			"source-env",
			{ project: "dest-proj", name: "dest-env" },
			"u-1",
		);
	});

	test("getEnvironment returns raw YAML with ETag headers", async () => {
		const esc = mockEscService();
		const app = createTestApp(esc);

		const res = await app.request("/esc/environments/my-org/proj/staging");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(mockEnv.yamlBody);
		expect(res.headers.get("content-type")).toContain("text/x-yaml");
		expect(res.headers.get("etag")).toBe('W/"r3"');
		expect(res.headers.get("Pulumi-ESC-Revision")).toBe("3");
	});

	test("updateEnvironment accepts raw YAML and If-Match", async () => {
		const esc = mockEscService();
		const app = createTestApp(esc);

		const res = await app.request("/esc/environments/my-org/proj/staging", {
			method: "PATCH",
			headers: { "If-Match": 'W/"r3"', "Content-Type": "text/x-yaml" },
			body: "values:\n  greeting: updated\n",
		});
		expect(res.status).toBe(200);
		expect(esc.validateYaml).toHaveBeenCalledWith("values:\n  greeting: updated\n");
		expect(esc.updateEnvironment).toHaveBeenCalledWith(
			"t-1",
			"proj",
			"staging",
			{ yamlBody: "values:\n  greeting: updated\n" },
			"u-1",
		);
	});

	test("updateEnvironment returns 412 on ETag mismatch", async () => {
		const esc = mockEscService();
		const app = createTestApp(esc);

		const res = await app.request("/esc/environments/my-org/proj/staging", {
			method: "PATCH",
			headers: { "If-Match": 'W/"r99"' },
			body: "values: {}\n",
		});
		expect(res.status).toBe(412);
		expect(esc.updateEnvironment).not.toHaveBeenCalled();
	});

	test("validateYaml returns esc-compatible properties JSON", async () => {
		const esc = mockEscService();
		const app = createTestApp(esc);

		const res = await app.request("/esc/environments/my-org/yaml/check", {
			method: "POST",
			body: "values:\n  greeting: hello\n",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { properties: Record<string, { value?: unknown }> };
		expect(body.properties.greeting?.value).toBe("hello");
	});

	test("open + get session return CLI wire shapes", async () => {
		const esc = mockEscService();
		const app = createTestApp(esc);

		const open = await app.request("/esc/environments/my-org/proj/staging/open", {
			method: "POST",
		});
		expect(open.status).toBe(200);
		expect(await open.json()).toEqual({ id: "sess-1" });

		const fetchRes = await app.request("/esc/environments/my-org/proj/staging/open/sess-1");
		expect(fetchRes.status).toBe(200);
		const fetched = (await fetchRes.json()) as {
			properties: { nested: { value: { value: { secret?: boolean; value?: unknown } } } };
		};
		expect(fetched.properties.nested.value.value.secret).toBe(true);
		expect(fetched.properties.nested.value.value.value).toBe(42);
	});

	test("draft handlers use raw YAML and draft ETags", async () => {
		const esc = mockEscService();
		const app = createTestApp(esc);

		const createRes = await app.request("/esc/environments/my-org/proj/staging/drafts", {
			method: "POST",
			headers: { ETag: 'W/"r3"' },
			body: "values:\n  greeting: updated\n",
		});
		expect(createRes.status).toBe(201);
		expect(await createRes.json()).toEqual({ changeRequestId: "draft-1", latestRevisionNumber: 3 });

		const getRes = await app.request("/esc/environments/my-org/proj/staging/drafts/draft-1");
		expect(getRes.status).toBe(200);
		expect(await getRes.text()).toBe(mockDraft.yamlBody);
		expect(getRes.headers.get("etag")).toBe('W/"d1735689600000"');

		const patchRes = await app.request("/esc/environments/my-org/proj/staging/drafts/draft-1", {
			method: "PATCH",
			headers: { "If-Match": 'W/"d1735689600000"' },
			body: "values:\n  greeting: newer\n",
		});
		expect(patchRes.status).toBe(200);
		expect(await patchRes.json()).toEqual({ changeRequestId: "draft-1", latestRevisionNumber: 3 });
		expect(esc.updateDraft).toHaveBeenCalledWith(
			"t-1",
			"proj",
			"staging",
			"draft-1",
			"values:\n  greeting: newer\n",
		);
	});

	test("internal dashboard routes keep JSON payload contract", async () => {
		const esc = mockEscService();
		const app = createTestApp(esc);

		const getRes = await app.request("/esc/v1-internal/environments/my-org/proj/staging");
		expect(getRes.status).toBe(200);
		const getBody = (await getRes.json()) as { yamlBody: string; createdBy: string };
		expect(getBody.yamlBody).toBe(mockEnv.yamlBody);
		expect(getBody.createdBy).toBe("owner@example.com");

		const patchRes = await app.request("/esc/v1-internal/environments/my-org/proj/staging", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ yamlBody: "values:\n  greeting: dashboard\n" }),
		});
		expect(patchRes.status).toBe(200);
		expect(esc.updateEnvironment).toHaveBeenCalledWith(
			"t-1",
			"proj",
			"staging",
			{ yamlBody: "values:\n  greeting: dashboard\n" },
			"u-1",
		);
	});
});
