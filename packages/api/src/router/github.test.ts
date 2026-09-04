import { describe, expect, mock, test } from "bun:test";
import type { GitHubService } from "@procella/github";
import type { TRPCContext } from "../trpc.js";
import { githubRouter } from "./github.js";

const mockInstallation = {
	id: "inst-uuid-1",
	installationId: 12345,
	tenantId: "t-1",
	accountLogin: "my-org",
	accountType: "Organization" as const,
	repositorySelection: "all" as const,
	createdAt: new Date("2025-01-01"),
	updatedAt: new Date("2025-01-01"),
};

function mockGitHubService(overrides?: Partial<GitHubService>): GitHubService {
	return {
		handleWebhookEvent: mock(async () => {}),
		issueInstallationUrl: mock(async () => "https://github.com/apps/procella/installations/new"),
		completeInstallation: mock(async () => mockInstallation),
		listInstallations: mock(async () => [mockInstallation]),
		resolveInstallation: mock(async () => mockInstallation),
		removeInstallation: mock(async () => {}),
		createPRComment: mock(async () => 1),
		findPRComment: mock(async () => null),
		updatePRComment: mock(async () => {}),
		setCommitStatus: mock(async () => {}),
		...overrides,
	};
}

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
		esc: {} as never,
		github: mockGitHubService(),
		...overrides,
	};
}

describe("githubRouter", () => {
	test("status distinguishes server configuration from tenant installations", async () => {
		const configured = await githubRouter.createCaller(mockContext()).status();
		expect(configured).toEqual({ configured: true, installations: [mockInstallation] });

		const unavailable = await githubRouter.createCaller(mockContext({ github: null })).status();
		expect(unavailable).toEqual({ configured: false, installations: [] });
	});

	test("status is available to non-admin members", async () => {
		const ctx = mockContext({
			caller: {
				tenantId: "t-1",
				orgSlug: "my-org",
				userId: "u-2",
				login: "viewer",
				roles: ["viewer"],
				principalType: "user",
			},
		});
		expect((await githubRouter.createCaller(ctx).status()).configured).toBe(true);
	});

	test("createInstallationUrl issues tenant-bound URL for admins", async () => {
		const ctx = mockContext();
		const result = await githubRouter.createCaller(ctx).createInstallationUrl();
		expect(result.url).toContain("github.com/apps/procella/installations/new");
		expect(ctx.github?.issueInstallationUrl).toHaveBeenCalledWith("t-1");
	});

	test("createInstallationUrl rejects non-admin callers", async () => {
		const ctx = mockContext({
			caller: {
				tenantId: "t-1",
				orgSlug: "my-org",
				userId: "u-2",
				login: "viewer",
				roles: ["viewer"],
				principalType: "user",
			},
		});
		await expect(githubRouter.createCaller(ctx).createInstallationUrl()).rejects.toThrow(
			"Admin role required",
		);
	});

	test("createInstallationUrl reports disabled server configuration", async () => {
		await expect(
			githubRouter.createCaller(mockContext({ github: null })).createInstallationUrl(),
		).rejects.toThrow("GitHub App is not configured");
	});

	test("removeInstallation is tenant scoped and admin only", async () => {
		const ctx = mockContext();
		expect(
			await githubRouter.createCaller(ctx).removeInstallation({ installationId: 12345 }),
		).toEqual({ success: true });
		expect(ctx.github?.removeInstallation).toHaveBeenCalledWith("t-1", 12345);

		const nonAdmin = mockContext({
			caller: {
				tenantId: "t-1",
				orgSlug: "my-org",
				userId: "u-2",
				login: "viewer",
				roles: ["viewer"],
				principalType: "user",
			},
		});
		await expect(
			githubRouter.createCaller(nonAdmin).removeInstallation({ installationId: 12345 }),
		).rejects.toThrow("Admin role required");
	});
});
