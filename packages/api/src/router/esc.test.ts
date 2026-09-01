import { describe, expect, mock, test } from "bun:test";
import type { TRPCContext } from "../trpc.js";
import { escRouter } from "./esc.js";

const VALID_DRAFT_ID = "11111111-1111-1111-8111-111111111111";

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
		webhooks: {} as never,
		esc: {
			listProjects: mock(async () => [
				{ id: "p1", tenantId: "t-1", name: "acme", createdAt: new Date(), updatedAt: new Date() },
			]),
			listEnvironments: mock(async () => [
				{
					id: "e1",
					projectId: "p1",
					name: "dev",
					yamlBody: "values:{}",
					currentRevisionNumber: 1,
					createdBy: "K3-key",
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			]),
			getEnvironment: mock(async () => ({
				id: "e1",
				projectId: "p1",
				name: "dev",
				yamlBody: "values:{}",
				currentRevisionNumber: 1,
				createdBy: "K3-key",
				createdAt: new Date(),
				updatedAt: new Date(),
			})),
			listRevisions: mock(async () => [
				{
					id: "r1",
					environmentId: "e1",
					revisionNumber: 1,
					yamlBody: "values:{}",
					createdBy: "K3-key",
					createdAt: new Date(),
				},
			]),
			getRevision: mock(async () => ({
				id: "r1",
				environmentId: "e1",
				revisionNumber: 1,
				yamlBody: "values:{}",
				createdBy: "K3-key",
				createdAt: new Date(),
			})),
			listRevisionTags: mock(async () => [
				{ name: "stable", revisionNumber: 1, createdBy: "K3-key", createdAt: new Date() },
			]),
			getEnvironmentTags: mock(async () => ({ team: "platform" })),
			listDrafts: mock(async () => [
				{
					id: "d1",
					environmentId: "e1",
					yamlBody: "values:{}",
					description: "draft",
					createdBy: "K3-key",
					status: "open",
					appliedRevisionId: null,
					appliedAt: null,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			]),
			getDraft: mock(async () => ({
				id: "d1",
				environmentId: "e1",
				yamlBody: "values:{}",
				description: "draft",
				createdBy: "K3-key",
				status: "open",
				appliedRevisionId: null,
				appliedAt: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			})),
		} as never,
		github: null,
		...overrides,
	};
}

describe("escRouter", () => {
	test("lists projects and environments for the caller tenant", async () => {
		const ctx = mockContext();
		const caller = escRouter.createCaller(ctx);

		await expect(caller.listProjects()).resolves.toHaveLength(1);
		await expect(caller.listEnvironments({ project: "acme" })).resolves.toHaveLength(1);
		expect(ctx.esc.listProjects).toHaveBeenCalledWith("t-1");
		expect(ctx.esc.listEnvironments).toHaveBeenCalledWith("t-1", "acme");
	});

	test("returns environment, revisions, tags, and drafts for the requested environment", async () => {
		const ctx = mockContext();
		const caller = escRouter.createCaller(ctx);

		await expect(
			caller.getEnvironment({ project: "acme", environment: "dev" }),
		).resolves.toMatchObject({ name: "dev" });
		await expect(
			caller.listRevisions({ project: "acme", environment: "dev" }),
		).resolves.toHaveLength(1);
		await expect(
			caller.getRevision({ project: "acme", environment: "dev", revision: 1 }),
		).resolves.toMatchObject({ revisionNumber: 1 });
		await expect(
			caller.listRevisionTags({ project: "acme", environment: "dev" }),
		).resolves.toHaveLength(1);
		await expect(
			caller.getEnvironmentTags({ project: "acme", environment: "dev" }),
		).resolves.toEqual({ team: "platform" });
		await expect(
			caller.listDrafts({ project: "acme", environment: "dev", status: "open" }),
		).resolves.toHaveLength(1);
		await expect(
			caller.getDraft({ project: "acme", environment: "dev", draftId: VALID_DRAFT_ID }),
		).resolves.toMatchObject({ id: "d1" });
	});

	test("replaces stored creator subjects with user identities", async () => {
		const resolveUserDisplayName = mock(async (subject: string) =>
			subject === "K3-key" ? "owner@example.com" : null,
		);
		const caller = escRouter.createCaller(mockContext({ resolveUserDisplayName }));

		const [environments, environment, revisions, revision, tags, drafts, draft] = await Promise.all(
			[
				caller.listEnvironments({ project: "acme" }),
				caller.getEnvironment({ project: "acme", environment: "dev" }),
				caller.listRevisions({ project: "acme", environment: "dev" }),
				caller.getRevision({ project: "acme", environment: "dev", revision: 1 }),
				caller.listRevisionTags({ project: "acme", environment: "dev" }),
				caller.listDrafts({ project: "acme", environment: "dev" }),
				caller.getDraft({ project: "acme", environment: "dev", draftId: VALID_DRAFT_ID }),
			],
		);

		expect(environments[0]?.createdBy).toBe("owner@example.com");
		expect(environment.createdBy).toBe("owner@example.com");
		expect(revisions[0]?.createdBy).toBe("owner@example.com");
		expect(revision.createdBy).toBe("owner@example.com");
		expect(tags[0]?.createdBy).toBe("owner@example.com");
		expect(drafts[0]?.createdBy).toBe("owner@example.com");
		expect(draft.createdBy).toBe("owner@example.com");
	});

	test("uses a safe label when a creator subject cannot be resolved", async () => {
		const caller = escRouter.createCaller(
			mockContext({ resolveUserDisplayName: async () => null }),
		);

		const environments = await caller.listEnvironments({ project: "acme" });

		expect(environments[0]?.createdBy).toBe("Unknown user");
		expect(environments[0]?.createdBy).not.toContain("K3-key");
	});

	test("bounds concurrent creator identity lookups for large lists", async () => {
		const environments = Array.from({ length: 20 }, (_, index) => ({
			id: `e${index}`,
			projectId: "p1",
			name: `env-${index}`,
			yamlBody: "values:{}",
			currentRevisionNumber: 1,
			createdBy: `K3-key-${index}`,
			createdAt: new Date(),
			updatedAt: new Date(),
		}));
		let activeLookups = 0;
		let maxActiveLookups = 0;
		const resolveUserDisplayName = mock(async (subject: string) => {
			activeLookups += 1;
			maxActiveLookups = Math.max(maxActiveLookups, activeLookups);
			await Promise.resolve();
			activeLookups -= 1;
			return `${subject}@example.com`;
		});
		const baseContext = mockContext();
		const caller = escRouter.createCaller(
			mockContext({
				resolveUserDisplayName,
				esc: {
					...baseContext.esc,
					listEnvironments: mock(async () => environments),
				} as never,
			}),
		);

		const result = await caller.listEnvironments({ project: "acme" });

		expect(result).toHaveLength(20);
		expect(resolveUserDisplayName).toHaveBeenCalledTimes(20);
		expect(maxActiveLookups).toBeLessThanOrEqual(8);
	});

	test("maps missing environment, revision, and draft to NOT_FOUND errors", async () => {
		const ctx = mockContext({
			esc: {
				...mockContext().esc,
				getEnvironment: mock(async () => null),
				getRevision: mock(async () => null),
				getDraft: mock(async () => null),
			} as never,
		});
		const caller = escRouter.createCaller(ctx);

		await expect(
			caller.getEnvironment({ project: "acme", environment: "missing" }),
		).rejects.toThrow("Environment acme/missing not found");
		await expect(
			caller.getRevision({ project: "acme", environment: "dev", revision: 2 }),
		).rejects.toThrow("Revision acme/dev#2 not found");
		await expect(
			caller.getDraft({ project: "acme", environment: "dev", draftId: VALID_DRAFT_ID }),
		).rejects.toThrow(`Draft ${VALID_DRAFT_ID} not found`);
	});

	test("validates required inputs and draft status values", async () => {
		const ctx = mockContext();
		const caller = escRouter.createCaller(ctx);

		await expect(caller.listEnvironments({ project: "" })).rejects.toThrow();
		await expect(
			caller.getRevision({ project: "acme", environment: "dev", revision: 0 }),
		).rejects.toThrow();
		await expect(
			caller.getDraft({ project: "acme", environment: "dev", draftId: "not-a-uuid" }),
		).rejects.toThrow();
		await expect(
			caller.listDrafts({ project: "acme", environment: "dev", status: "bad" as never }),
		).rejects.toThrow();
	});
});
