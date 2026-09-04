import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import type { Database } from "@procella/db";
import { OctokitGitHubService } from "@procella/github";
import { getTestDb, truncateTables } from "./setup.js";

const config = {
	appId: "123",
	slug: "procella-test",
	privateKey: "unused-in-tests",
	webhookSecret: "webhook-secret",
	stateSigningKey: "state-signing-key-state-signing-key",
};

const installations = new Map([
	[
		101,
		{
			id: 101,
			app_id: 123,
			account: { login: "acme" },
			target_type: "Organization",
			repository_selection: "all",
		},
	],
	[
		102,
		{
			id: 102,
			app_id: 123,
			account: { login: "octocat" },
			target_type: "User",
			repository_selection: "selected",
		},
	],
	[
		201,
		{
			id: 201,
			app_id: 123,
			account: { login: "globex" },
			target_type: "Organization",
			repository_selection: "all",
		},
	],
] as const);

let db: Database;

beforeAll(() => {
	db = getTestDb();
});

afterEach(async () => {
	await truncateTables();
});

function createService() {
	const appClient = {
		request: async (_route: string, input: { installation_id: number }) => {
			const data = installations.get(input.installation_id as 101 | 102 | 201);
			if (!data) throw Object.assign(new Error("Not Found"), { status: 404 });
			return { data };
		},
	} as unknown as Octokit;
	return new OctokitGitHubService({ db, config, appClient });
}

async function issueState(service: OctokitGitHubService, tenantId: string): Promise<string> {
	const url = new URL(await service.issueInstallationUrl(tenantId));
	const state = url.searchParams.get("state");
	if (!state) throw new Error("Installation URL did not include state");
	return state;
}

async function bind(service: OctokitGitHubService, tenantId: string, installationId: number) {
	return service.completeInstallation(await issueState(service, tenantId), installationId);
}

describe("GitHub installation binding integration", () => {
	test("isolates multiple installations across multiple tenants", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);
		await bind(service, "tenant-a", 102);
		await bind(service, "tenant-b", 201);

		expect(
			(await service.listInstallations("tenant-a"))
				.map((row) => row.installationId)
				.sort((a, b) => a - b),
		).toEqual([101, 102]);
		expect((await service.listInstallations("tenant-b")).map((row) => row.installationId)).toEqual([
			201,
		]);
	});

	test("rejects cross-tenant state use for an already-bound installation", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);

		await expect(bind(service, "tenant-b", 101)).rejects.toMatchObject({
			code: "installation_conflict",
		});
		expect(await service.listInstallations("tenant-a")).toHaveLength(1);
		expect(await service.listInstallations("tenant-b")).toHaveLength(0);
	});

	test("consumes setup state exactly once under concurrent callbacks", async () => {
		const service = createService();
		const state = await issueState(service, "tenant-a");
		const results = await Promise.allSettled([
			service.completeInstallation(state, 101),
			service.completeInstallation(state, 101),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected).toMatchObject({
			status: "rejected",
			reason: { code: "replayed_state" },
		});
		expect(await service.listInstallations("tenant-a")).toHaveLength(1);
	});

	test("tenant-scoped removal cannot delete another tenant installation", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);
		await service.removeInstallation("tenant-b", 101);
		expect(await service.listInstallations("tenant-a")).toHaveLength(1);
	});

	test("webhooks update and delete only existing installation bindings", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);

		await service.handleWebhookEvent("installation_repositories", {
			action: "removed",
			installation: {
				id: 101,
				account: { login: "acme-renamed", type: "Organization" },
				repository_selection: "selected",
			},
		});
		expect(await service.listInstallations("tenant-a")).toMatchObject([
			{ accountLogin: "acme-renamed", repositorySelection: "selected" },
		]);

		await service.handleWebhookEvent("installation", {
			action: "deleted",
			installation: { id: 101 },
		});
		expect(await service.listInstallations("tenant-a")).toHaveLength(0);
	});
});
