import { type GitHubService, GitHubSetupError } from "@procella/github";
import { BadRequestError } from "@procella/types";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param } from "./params.js";

export function githubHandlers(deps: {
	github: GitHubService | null;
	webhookSecret?: string;
	verifySignature: (payload: string, signature: string, secret: string) => Promise<boolean>;
}) {
	return {
		handleGitHubWebhook: async (c: Context<Env>) => {
			const payload = await c.req.text();
			const signature = c.req.header("X-Hub-Signature-256") ?? "";
			const event = c.req.header("X-GitHub-Event") ?? "";

			if (!deps.github || !deps.webhookSecret) {
				return c.body(null, 200);
			}

			if (!event) {
				throw new BadRequestError("Missing X-GitHub-Event header");
			}

			const valid = await deps.verifySignature(payload, signature, deps.webhookSecret);
			if (!valid) {
				return c.json({ error: "Invalid webhook signature" }, 401);
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(payload) as unknown;
			} catch {
				throw new BadRequestError("Invalid JSON payload");
			}
			await deps.github.handleWebhookEvent(event, parsed);
			return c.body(null, 200);
		},

		completeInstallation: async (c: Context<Env>) => {
			c.header("Cache-Control", "no-store");
			if (!deps.github) {
				return redirectToGitHubSettings(c, "not_configured");
			}

			const state = c.req.query("state");
			const installationIdValue = c.req.query("installation_id");
			const setupAction = c.req.query("setup_action");
			if (
				!state ||
				state.length > 4096 ||
				!installationIdValue ||
				!/^[1-9]\d*$/.test(installationIdValue) ||
				(setupAction !== "install" && setupAction !== "update")
			) {
				return redirectToGitHubSettings(c, "invalid_callback");
			}

			const installationId = Number(installationIdValue);
			if (!Number.isSafeInteger(installationId)) {
				return redirectToGitHubSettings(c, "invalid_callback");
			}

			try {
				await deps.github.completeInstallation(state, installationId);
				return c.redirect("/settings?github=connected#github", 303);
			} catch (error) {
				const reason = error instanceof GitHubSetupError ? error.code : "github_error";
				return redirectToGitHubSettings(c, reason);
			}
		},

		getInstallation: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			if (org !== caller.orgSlug) {
				throw new BadRequestError("Organization does not match caller organization");
			}

			if (!deps.github) {
				return c.json({ installation: null });
			}

			const installations = await deps.github.listInstallations(caller.tenantId);
			return c.json({ installation: installations[0] ?? null });
		},

		removeInstallation: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			if (org !== caller.orgSlug) {
				throw new BadRequestError("Organization does not match caller organization");
			}

			if (!deps.github) {
				return c.body(null, 204);
			}

			const installations = await deps.github.listInstallations(caller.tenantId);
			await Promise.all(
				installations.map((installation) =>
					deps.github?.removeInstallation(caller.tenantId, installation.installationId),
				),
			);

			return c.body(null, 204);
		},
	};
}

function redirectToGitHubSettings(c: Context<Env>, reason: string) {
	return c.redirect(`/settings?github=error&reason=${encodeURIComponent(reason)}#github`, 303);
}
