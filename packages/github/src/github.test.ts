import { describe, expect, mock, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import type { Config } from "@procella/config";
import type { Database } from "@procella/db";
import {
	buildGitHubAppConfig,
	buildPRCommentBody,
	createGitHubSetupStateService,
	type GitHubInstallationInfo,
	GitHubSetupError,
	mapUpdateStatusToCommitState,
	OctokitGitHubService,
	verifyGitHubWebhookSignature,
} from "./index.js";

describe("@procella/github", () => {
	describe("verifyGitHubWebhookSignature", () => {
		test("returns true for valid signature", async () => {
			const payload = JSON.stringify({ hello: "world" });
			const secret = "webhook-secret";
			const key = await crypto.subtle.importKey(
				"raw",
				new TextEncoder().encode(secret),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"],
			);
			const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
			const hex = Array.from(new Uint8Array(sig))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");

			const ok = await verifyGitHubWebhookSignature(payload, `sha256=${hex}`, secret);
			expect(ok).toBe(true);
		});

		test("returns false for tampered signature", async () => {
			const payload = JSON.stringify({ hello: "world" });
			const ok = await verifyGitHubWebhookSignature(payload, "sha256=deadbeef", "webhook-secret");
			expect(ok).toBe(false);
		});

		test("returns false for empty signature", async () => {
			const payload = JSON.stringify({ hello: "world" });
			const ok = await verifyGitHubWebhookSignature(payload, "", "webhook-secret");
			expect(ok).toBe(false);
		});
	});

	describe("buildPRCommentBody", () => {
		test("builds markdown body with table and details link", () => {
			const body = buildPRCommentBody({
				org: "acme",
				project: "infra",
				stack: "dev",
				kind: "preview",
				status: "succeeded",
				resourceChanges: { creates: 3, updates: 1, deletes: 0, sames: 4 },
				permalink: "https://example.com/update/1",
			});

			expect(body).toContain("## Pulumi Preview Results");
			expect(body).toContain("**Stack:** `acme/infra/dev`");
			expect(body).toContain("| Create | 3 |");
			expect(body).toContain("| Update | 1 |");
			expect(body).toContain("| Delete | 0 |");
			expect(body).toContain("[View details](https://example.com/update/1)");
		});

		test("defaults missing resource changes to zero", () => {
			const body = buildPRCommentBody({
				org: "acme",
				project: "infra",
				stack: "dev",
				kind: "preview",
				status: "failed",
			});

			expect(body).toContain("| Create | 0 |");
			expect(body).toContain("| Update | 0 |");
			expect(body).toContain("| Delete | 0 |");
		});
	});

	describe("mapUpdateStatusToCommitState", () => {
		test("maps Procella update statuses to GitHub commit states", () => {
			expect(mapUpdateStatusToCommitState("succeeded")).toBe("success");
			expect(mapUpdateStatusToCommitState("failed")).toBe("failure");
			expect(mapUpdateStatusToCommitState("cancelled")).toBe("failure");
			expect(mapUpdateStatusToCommitState("running")).toBe("pending");
			expect(mapUpdateStatusToCommitState("requested")).toBe("pending");
			expect(mapUpdateStatusToCommitState("not started")).toBe("pending");
			expect(mapUpdateStatusToCommitState("unknown")).toBe("error");
		});
	});
});

const testConfig = {
	appId: "123",
	privateKey: "unused-in-tests",
	webhookSecret: "webhook-secret",
	stateSigningKey: "state-signing-key-state-signing-key",
};

const installationRow = {
	id: "row-1",
	tenantId: "tenant-a",
	installationId: 101,
	accountLogin: "acme",
	accountType: "Organization",
	repositorySelection: "all",
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
} satisfies GitHubInstallationInfo;

function readOnlyDb(rows: GitHubInstallationInfo[]): Database {
	const chain = {
		where: mock(() => chain),
		orderBy: mock(async () => rows),
		limit: mock(async () => rows.slice(0, 1)),
	};
	return { select: mock(() => ({ from: mock(() => chain) })) } as unknown as Database;
}

describe("GitHub setup state", () => {
	test("derives the current App slug from GitHub for every installation URL", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const slugs = ["procella-original", "procella-renamed"];
		const request = mock(async () => ({ data: { id: 123, slug: slugs.shift() } }));
		const values = mock(async () => []);
		const service = new OctokitGitHubService({
			db: {
				delete: mock(() => ({ where: mock(async () => []) })),
				insert: mock(() => ({ values })),
			} as unknown as Database,
			config: testConfig,
			appClient: { request } as unknown as Octokit,
			setupStates,
		});

		const first = new URL(await service.issueInstallationUrl("tenant-a"));
		const second = new URL(await service.issueInstallationUrl("tenant-a"));
		expect(first.origin + first.pathname).toBe(
			"https://github.com/apps/procella-original/installations/new",
		);
		expect(second.origin + second.pathname).toBe(
			"https://github.com/apps/procella-renamed/installations/new",
		);
		expect(request).toHaveBeenCalledTimes(2);
		expect(request).toHaveBeenNthCalledWith(1, "GET /app");
		expect(request).toHaveBeenNthCalledWith(2, "GET /app");
		const claims = await setupStates.verify(second.searchParams.get("state") ?? "");
		expect(claims.tenantId).toBe("tenant-a");
	});

	test("fails closed before persisting state when App discovery is invalid", async () => {
		const deleteState = mock(() => ({ where: mock(async () => []) }));
		const insertState = mock(() => ({ values: mock(async () => []) }));
		const service = new OctokitGitHubService({
			db: { delete: deleteState, insert: insertState } as unknown as Database,
			config: testConfig,
			appClient: {
				request: mock(async () => ({ data: { id: 999, slug: "wrong-app" } })),
			} as unknown as Octokit,
		});

		await expect(service.issueInstallationUrl("tenant-a")).rejects.toThrow(
			"Unable to verify configured GitHub App",
		);
		expect(deleteState).not.toHaveBeenCalled();
		expect(insertState).not.toHaveBeenCalled();
	});

	test("builds App configuration without a slug setting", () => {
		const config = buildGitHubAppConfig({
			githubAppId: "123",
			githubAppPrivateKey: "private-key",
			githubAppWebhookSecret: "webhook-secret",
			ticketSigningKey: "state-signing-key-state-signing-key",
		} as Config);
		expect(config).toEqual({
			appId: "123",
			privateKey: "private-key",
			webhookSecret: "webhook-secret",
			stateSigningKey: "state-signing-key-state-signing-key",
		});
	});

	test("rejects tampered state", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const { state } = await setupStates.issue("tenant-a");
		const [header, payload, signature] = state.split(".");
		const tamperedSignature = `${signature?.startsWith("A") ? "B" : "A"}${signature?.slice(1)}`;
		const tampered = `${header}.${payload}.${tamperedSignature}`;
		await expect(setupStates.verify(tampered)).rejects.toMatchObject({ code: "invalid_state" });
	});

	test("rejects expired state", async () => {
		let now = new Date("2026-01-01T00:00:00Z");
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey, {
			now: () => now,
			ttlSeconds: 60,
		});
		const { state } = await setupStates.issue("tenant-a");
		now = new Date("2026-01-01T00:01:01Z");
		await expect(setupStates.verify(state)).rejects.toMatchObject({ code: "expired_state" });
	});
});

describe("OctokitGitHubService installation binding", () => {
	test("loads authoritative installation data from GitHub before persisting", async () => {
		const installationReturning = mock(async () => [installationRow]);
		const onConflictDoUpdate = mock(() => ({ returning: installationReturning }));
		const values = mock(() => ({ onConflictDoUpdate }));
		const consumedReturning = mock(async () => [{ jti: "state-id" }]);
		const tx = {
			delete: mock(() => ({
				where: mock(() => ({ returning: consumedReturning })),
			})),
			insert: mock(() => ({ values })),
		} as unknown as Database;
		const db = {
			transaction: mock(async (callback: (transaction: Database) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as Database;
		const request = mock(async () => ({
			data: {
				id: 101,
				app_id: 123,
				account: { login: "acme" },
				target_type: "Organization",
				repository_selection: "all",
			},
		}));
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const service = new OctokitGitHubService({
			db,
			config: testConfig,
			appClient: { request } as unknown as Octokit,
			setupStates,
		});

		const { state } = await setupStates.issue("tenant-a");
		const result = await service.completeInstallation(state, 101);
		expect(result).toEqual(installationRow);
		expect(request).toHaveBeenCalledWith("GET /app/installations/{installation_id}", {
			installation_id: 101,
		});
		expect(values).toHaveBeenCalledWith({
			tenantId: "tenant-a",
			installationId: 101,
			accountLogin: "acme",
			accountType: "Organization",
			repositorySelection: "all",
		});
	});

	test("rejects concurrent reuse of a consumed setup state", async () => {
		const insert = mock(() => {
			throw new Error("must not persist");
		});
		const tx = {
			delete: mock(() => ({
				where: mock(() => ({ returning: mock(async () => []) })),
			})),
			insert,
		} as unknown as Database;
		const db = {
			transaction: mock(async (callback: (transaction: Database) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as Database;
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const service = new OctokitGitHubService({
			db,
			config: testConfig,
			appClient: {
				request: mock(async () => ({
					data: {
						id: 101,
						app_id: 123,
						account: { login: "acme" },
						target_type: "Organization",
						repository_selection: "all",
					},
				})),
			} as unknown as Octokit,
			setupStates,
		});

		const { state } = await setupStates.issue("tenant-a");
		await expect(service.completeInstallation(state, 101)).rejects.toMatchObject({
			code: "replayed_state",
		});
		expect(insert).not.toHaveBeenCalled();
	});

	test("rejects a forged installation id that GitHub does not recognize", async () => {
		const transaction = mock(() => {
			throw new Error("must not persist");
		});
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const service = new OctokitGitHubService({
			db: { transaction } as unknown as Database,
			config: testConfig,
			appClient: {
				request: mock(async () => {
					throw Object.assign(new Error("Not Found"), { status: 404 });
				}),
			} as unknown as Octokit,
			setupStates,
		});

		const { state } = await setupStates.issue("tenant-a");
		await expect(service.completeInstallation(state, 999)).rejects.toBeInstanceOf(GitHubSetupError);
		expect(transaction).not.toHaveBeenCalled();
	});

	test("rejects installation data for a different GitHub App", async () => {
		const transaction = mock(() => {
			throw new Error("must not persist");
		});
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const service = new OctokitGitHubService({
			db: { transaction } as unknown as Database,
			config: testConfig,
			appClient: {
				request: mock(async () => ({
					data: {
						id: 999,
						app_id: 999,
						account: { login: "attacker" },
						target_type: "Organization",
						repository_selection: "all",
					},
				})),
			} as unknown as Octokit,
			setupStates,
		});

		const { state } = await setupStates.issue("tenant-a");
		await expect(service.completeInstallation(state, 999)).rejects.toMatchObject({
			code: "invalid_installation",
		});
		expect(transaction).not.toHaveBeenCalled();
	});

	test("unknown webhook installations cannot invent a tenant binding", async () => {
		const insert = mock(() => {
			throw new Error("must not insert");
		});
		const update = mock(() => {
			throw new Error("must not update");
		});
		const service = new OctokitGitHubService({
			db: Object.assign(readOnlyDb([]), { insert, update }),
			config: testConfig,
			appClient: {} as Octokit,
		});

		await service.handleWebhookEvent("installation", {
			action: "created",
			installation: {
				id: 777,
				account: { login: "forged-tenant", type: "Organization" },
				repository_selection: "all",
			},
		});
		expect(insert).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});
});

describe("OctokitGitHubService repository resolution", () => {
	test("resolves a renamed account from the authoritative installation id", async () => {
		const request = mock(async () => ({ data: { id: 101 } }));
		const service = new OctokitGitHubService({
			db: readOnlyDb([installationRow]),
			config: testConfig,
			appClient: { request } as unknown as Octokit,
		});

		expect(
			await service.resolveInstallation({
				tenantId: "tenant-a",
				owner: "renamed-acme",
				repo: "infra",
			}),
		).toEqual(installationRow);
		expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/installation", {
			owner: "renamed-acme",
			repo: "infra",
		});
	});

	test("rejects a public repository that is not selected for the installation", async () => {
		const selected: GitHubInstallationInfo = {
			...installationRow,
			repositorySelection: "selected",
		};
		const reposGet = mock(async () => ({ data: { id: 1, visibility: "public" } }));
		const request = mock(async () => {
			throw Object.assign(new Error("Not Found"), { status: 404 });
		});
		const service = new OctokitGitHubService({
			db: readOnlyDb([selected]),
			config: testConfig,
			appClient: { request } as unknown as Octokit,
			installationClientFactory: () =>
				({ rest: { repos: { get: reposGet } } }) as unknown as Octokit,
		});

		expect(
			await service.resolveInstallation({ tenantId: "tenant-a", owner: "acme", repo: "public" }),
		).toBeNull();
		expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/installation", {
			owner: "acme",
			repo: "public",
		});
		expect(reposGet).not.toHaveBeenCalled();
	});

	test("rejects an authoritative installation that is not bound to the tenant", async () => {
		const request = mock(async () => ({ data: { id: 999 } }));
		const service = new OctokitGitHubService({
			db: readOnlyDb([installationRow]),
			config: testConfig,
			appClient: { request } as unknown as Octokit,
		});

		expect(
			await service.resolveInstallation({ tenantId: "tenant-a", owner: "acme", repo: "infra" }),
		).toBeNull();
	});

	test("selects the tenant-bound installation returned by the app-JWT lookup", async () => {
		const denied = { ...installationRow, id: "row-2", installationId: 102 };
		const allowed = { ...installationRow, id: "row-3", installationId: 103 };
		const request = mock(async () => ({ data: { id: 103 } }));
		const service = new OctokitGitHubService({
			db: readOnlyDb([denied, allowed]),
			config: testConfig,
			appClient: { request } as unknown as Octokit,
		});

		expect(
			await service.resolveInstallation({ tenantId: "tenant-a", owner: "acme", repo: "infra" }),
		).toEqual(allowed);
	});
});
