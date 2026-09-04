import { describe, expect, mock, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import type { Database } from "@procella/db";
import {
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
	slug: "procella-test",
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
	test("round-trips the tenant through a signed installation URL", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const service = new OctokitGitHubService({
			db: readOnlyDb([]),
			config: testConfig,
			appClient: {} as Octokit,
			setupStates,
		});
		const url = new URL(await service.issueInstallationUrl("tenant-a"));
		expect(url.origin + url.pathname).toBe(
			"https://github.com/apps/procella-test/installations/new",
		);
		expect(await setupStates.verify(url.searchParams.get("state") ?? "")).toBe("tenant-a");
	});

	test("rejects tampered state", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const state = await setupStates.issue("tenant-a");
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
		const state = await setupStates.issue("tenant-a");
		now = new Date("2026-01-01T00:01:01Z");
		await expect(setupStates.verify(state)).rejects.toMatchObject({ code: "expired_state" });
	});
});

describe("OctokitGitHubService installation binding", () => {
	test("loads authoritative installation data from GitHub before persisting", async () => {
		const returning = mock(async () => [installationRow]);
		const onConflictDoUpdate = mock(() => ({ returning }));
		const values = mock(() => ({ onConflictDoUpdate }));
		const db = { insert: mock(() => ({ values })) } as unknown as Database;
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

		const result = await service.completeInstallation(await setupStates.issue("tenant-a"), 101);
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

	test("rejects a forged installation id that GitHub does not recognize", async () => {
		const insert = mock(() => {
			throw new Error("must not persist");
		});
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const service = new OctokitGitHubService({
			db: { insert } as unknown as Database,
			config: testConfig,
			appClient: {
				request: mock(async () => {
					throw Object.assign(new Error("Not Found"), { status: 404 });
				}),
			} as unknown as Octokit,
			setupStates,
		});

		await expect(
			service.completeInstallation(await setupStates.issue("tenant-a"), 999),
		).rejects.toBeInstanceOf(GitHubSetupError);
		expect(insert).not.toHaveBeenCalled();
	});

	test("rejects installation data for a different GitHub App", async () => {
		const insert = mock(() => {
			throw new Error("must not persist");
		});
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const service = new OctokitGitHubService({
			db: { insert } as unknown as Database,
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

		await expect(
			service.completeInstallation(await setupStates.issue("tenant-a"), 999),
		).rejects.toMatchObject({ code: "invalid_installation" });
		expect(insert).not.toHaveBeenCalled();
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
	test("rejects an installation whose account does not own the target repository", async () => {
		const installationClientFactory = mock(() => ({}) as Octokit);
		const service = new OctokitGitHubService({
			db: readOnlyDb([installationRow]),
			config: testConfig,
			appClient: {} as Octokit,
			installationClientFactory,
		});

		expect(
			await service.resolveInstallation({ tenantId: "tenant-a", owner: "other", repo: "infra" }),
		).toBeNull();
		expect(installationClientFactory).not.toHaveBeenCalled();
	});
	test("fails closed when a selected-repository installation cannot access the target", async () => {
		const selected: GitHubInstallationInfo = {
			...installationRow,
			repositorySelection: "selected",
		};
		const get = mock(async () => {
			throw Object.assign(new Error("Not Found"), { status: 404 });
		});
		const service = new OctokitGitHubService({
			db: readOnlyDb([selected]),
			config: testConfig,
			appClient: {} as Octokit,
			installationClientFactory: () => ({ rest: { repos: { get } } }) as unknown as Octokit,
		});

		expect(
			await service.resolveInstallation({ tenantId: "tenant-a", owner: "acme", repo: "private" }),
		).toBeNull();
		expect(get).toHaveBeenCalledWith({ owner: "acme", repo: "private" });
	});

	test("selects the tenant installation that can access the repository", async () => {
		const denied = { ...installationRow, id: "row-2", installationId: 102 };
		const allowed = { ...installationRow, id: "row-3", installationId: 103 };
		const installationClientFactory = (installationId: number) =>
			({
				rest: {
					repos: {
						get: mock(async () => {
							if (installationId === 102) throw new Error("Not Found");
							return { data: { id: 1 } };
						}),
					},
				},
			}) as unknown as Octokit;
		const service = new OctokitGitHubService({
			db: readOnlyDb([denied, allowed]),
			config: testConfig,
			appClient: {} as Octokit,
			installationClientFactory,
		});

		expect(
			await service.resolveInstallation({ tenantId: "tenant-a", owner: "acme", repo: "infra" }),
		).toEqual(allowed);
	});
});
