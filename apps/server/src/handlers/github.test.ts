import { describe, expect, mock, test } from "bun:test";
import { type GitHubService, GitHubSetupError } from "@procella/github";
import type { Caller } from "@procella/types";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { githubHandlers } from "./github.js";

// ============================================================================
// Mock Data
// ============================================================================

const validCaller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "u-1",
	login: "test-user",
	roles: ["admin"],
	principalType: "user",
};

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

// ============================================================================
// Mock Services
// ============================================================================

function mockGitHubService(overrides?: Partial<GitHubService>): GitHubService {
	return {
		handleWebhookEvent: mock(async () => {}),
		issueInstallationUrl: mock(async () => "https://github.com/apps/procella/installations/new"),
		completeInstallation: mock(async () => mockInstallation),
		listInstallations: mock(async () => [mockInstallation]),
		resolveInstallation: mock(async () => mockInstallation),
		createPRComment: mock(async () => 1),
		findPRComment: mock(async () => null),
		updatePRComment: mock(async () => {}),
		setCommitStatus: mock(async () => {}),
		removeInstallation: mock(async () => {}),
		...overrides,
	};
}

function injectCaller(caller: Caller) {
	return async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
		c.set("caller", caller);
		await next();
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("githubHandlers", () => {
	describe("handleGitHubWebhook", () => {
		test("returns 200 when github is not configured", async () => {
			const app = new Hono<Env>();
			const h = githubHandlers({
				github: null,
				webhookSecret: undefined,
				verifySignature: mock(async () => true),
			});
			app.post("/webhooks/github", h.handleGitHubWebhook);

			const res = await app.request("/webhooks/github", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-GitHub-Event": "push",
					"X-Hub-Signature-256": "sha256=abc",
				},
				body: JSON.stringify({ action: "completed" }),
			});
			expect(res.status).toBe(200);
		});

		test("processes valid webhook event", async () => {
			const github = mockGitHubService();
			const verifySignature = mock(async () => true);
			const app = new Hono<Env>();
			const h = githubHandlers({
				github,
				webhookSecret: "secret",
				verifySignature,
			});
			app.post("/webhooks/github", h.handleGitHubWebhook);

			const res = await app.request("/webhooks/github", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-GitHub-Event": "installation",
					"X-Hub-Signature-256": "sha256=valid",
				},
				body: JSON.stringify({ action: "created" }),
			});
			expect(res.status).toBe(200);
			expect(github.handleWebhookEvent).toHaveBeenCalledTimes(1);
		});

		test("returns 401 for invalid signature", async () => {
			const github = mockGitHubService();
			const verifySignature = mock(async () => false);
			const app = new Hono<Env>();
			const h = githubHandlers({
				github,
				webhookSecret: "secret",
				verifySignature,
			});
			app.post("/webhooks/github", h.handleGitHubWebhook);

			const res = await app.request("/webhooks/github", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-GitHub-Event": "push",
					"X-Hub-Signature-256": "sha256=invalid",
				},
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(401);
		});

		test("returns error when X-GitHub-Event header missing", async () => {
			const github = mockGitHubService();
			const app = new Hono<Env>();
			app.onError((err, c) => c.json({ error: (err as Error).message }, 400));
			const h = githubHandlers({
				github,
				webhookSecret: "secret",
				verifySignature: mock(async () => true),
			});
			app.post("/webhooks/github", h.handleGitHubWebhook);

			const res = await app.request("/webhooks/github", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
		});
	});

	describe("completeInstallation", () => {
		test("accepts a valid GitHub setup callback and ignores forged account fields", async () => {
			const github = mockGitHubService();
			const app = new Hono<Env>();
			const h = githubHandlers({ github, verifySignature: mock(async () => true) });
			app.get("/github/setup", h.completeInstallation);

			const res = await app.request(
				"/github/setup?installation_id=12345&setup_action=install&state=signed-state&account_login=attacker",
			);
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/settings?github=connected#github");
			expect(github.completeInstallation).toHaveBeenCalledWith("signed-state", 12345);
		});

		test("rejects missing or malformed callback parameters before persistence", async () => {
			const github = mockGitHubService();
			const app = new Hono<Env>();
			const h = githubHandlers({ github, verifySignature: mock(async () => true) });
			app.get("/github/setup", h.completeInstallation);

			for (const query of [
				"installation_id=123&setup_action=install",
				"installation_id=not-a-number&setup_action=install&state=state",
				"installation_id=123&setup_action=other&state=state",
				`installation_id=123&setup_action=install&state=${"x".repeat(4097)}`,
			]) {
				const res = await app.request(`/github/setup?${query}`);
				expect(res.status).toBe(303);
				expect(res.headers.get("location")).toContain("reason=invalid_callback");
			}
			expect(github.completeInstallation).not.toHaveBeenCalled();
		});

		test("surfaces signed-state failures without persisting", async () => {
			const github = mockGitHubService({
				completeInstallation: mock(async () => {
					throw new GitHubSetupError("expired_state");
				}),
			});
			const app = new Hono<Env>();
			const h = githubHandlers({ github, verifySignature: mock(async () => true) });
			app.get("/github/setup", h.completeInstallation);

			const res = await app.request(
				"/github/setup?installation_id=123&setup_action=update&state=expired",
			);
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toContain("reason=expired_state");
		});
	});

	describe("getInstallation", () => {
		test("returns installation when configured", async () => {
			const github = mockGitHubService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = githubHandlers({
				github,
				verifySignature: mock(async () => true),
			});
			app.get("/orgs/:org/integrations/github", h.getInstallation);

			const res = await app.request("/orgs/my-org/integrations/github");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.installation.installationId).toBe(12345);
		});

		test("returns null installation when github not configured", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = githubHandlers({
				github: null,
				verifySignature: mock(async () => true),
			});
			app.get("/orgs/:org/integrations/github", h.getInstallation);

			const res = await app.request("/orgs/my-org/integrations/github");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.installation).toBeNull();
		});

		test("returns 400 for wrong org", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			app.onError((err, c) => c.json({ error: (err as Error).message }, 400));
			const h = githubHandlers({
				github: mockGitHubService(),
				verifySignature: mock(async () => true),
			});
			app.get("/orgs/:org/integrations/github", h.getInstallation);

			const res = await app.request("/orgs/wrong-org/integrations/github");
			expect(res.status).toBe(400);
		});
	});

	describe("removeInstallation", () => {
		test("returns 204 after removing installation", async () => {
			const github = mockGitHubService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = githubHandlers({
				github,
				verifySignature: mock(async () => true),
			});
			app.delete("/orgs/:org/integrations/github", h.removeInstallation);

			const res = await app.request("/orgs/my-org/integrations/github", { method: "DELETE" });
			expect(res.status).toBe(204);
			expect(github.removeInstallation).toHaveBeenCalledWith("t-1", 12345);
		});

		test("returns 204 when no installation exists", async () => {
			const github = mockGitHubService({
				listInstallations: mock(async () => []),
			});
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = githubHandlers({
				github,
				verifySignature: mock(async () => true),
			});
			app.delete("/orgs/:org/integrations/github", h.removeInstallation);

			const res = await app.request("/orgs/my-org/integrations/github", { method: "DELETE" });
			expect(res.status).toBe(204);
			expect(github.removeInstallation).not.toHaveBeenCalled();
		});

		test("returns 204 when github not configured", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = githubHandlers({
				github: null,
				verifySignature: mock(async () => true),
			});
			app.delete("/orgs/:org/integrations/github", h.removeInstallation);

			const res = await app.request("/orgs/my-org/integrations/github", { method: "DELETE" });
			expect(res.status).toBe(204);
		});
	});
});
