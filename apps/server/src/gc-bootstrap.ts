import { GitHubOutboxWorker, OctokitGitHubDeliveryService } from "@procella/github";
import type { ScheduledEvent } from "aws-lambda";

const LAMBDA_WORK_DEADLINE_MS = 52_000;

(async () => {
	const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API!;
	const BASE_URL = `http://${RUNTIME_API}/2018-06-01/runtime`;

	const { loadConfig } = await import("@procella/config");
	const { createDb } = await import("@procella/db");
	const { escGcSweep } = await import("@procella/esc");
	const { GCWorker } = await import("@procella/updates");

	const config = loadConfig();
	const { db } = await createDb({ url: config.databaseUrl, max: config.databasePoolMax });
	const gcWorker = new GCWorker({ db });
	const githubAppId = process.env.PROCELLA_GITHUB_DELIVERY_APP_ID;
	const githubPrivateKey = process.env.PROCELLA_GITHUB_DELIVERY_PRIVATE_KEY?.replace(/\\n/g, "\n");
	if (Boolean(githubAppId) !== Boolean(githubPrivateKey)) {
		throw new Error("GitHub delivery requires both App ID and private key");
	}
	const githubOutbox =
		githubAppId && githubPrivateKey
			? new GitHubOutboxWorker({
					db,
					github: new OctokitGitHubDeliveryService({
						db,
						config: { appId: githubAppId, privateKey: githubPrivateKey },
					}),
					maxPerRun: 5,
				})
			: null;

	while (true) {
		const res = await fetch(`${BASE_URL}/invocation/next`);
		const requestId = res.headers.get("Lambda-Runtime-Aws-Request-Id")!;
		void ((await res.json()) as ScheduledEvent);
		const invocationStartedAt = Date.now();

		try {
			await gcWorker.runOnce();
			if (githubOutbox) {
				await githubOutbox.runOnce({ deadlineMs: invocationStartedAt + LAMBDA_WORK_DEADLINE_MS });
			}
			await escGcSweep(db);
			await fetch(`${BASE_URL}/invocation/${requestId}/response`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "ok" }),
			});
		} catch (err: unknown) {
			const error = err instanceof Error ? err : new Error(String(err));
			await fetch(`${BASE_URL}/invocation/${requestId}/error`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					errorMessage: error.message,
					errorType: error.name,
					stackTrace: error.stack?.split("\n") || [],
				}),
			});
		}
	}
})();
