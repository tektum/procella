import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import type { Database } from "@procella/db";
import {
	createGitHubSetupStateService,
	OctokitGitHubService,
} from "@procella/github";
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

async function bind(service: OctokitGitHubService, tenantId: string, installationId: number) {
	const states = createGitHubSetupStateService(config.stateSigningKey);
	return service.completeInstallation(await states.issue(tenantId), installationId);
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
