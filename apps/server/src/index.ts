import { formatConfigErrors } from "@procella/config";
import { GitHubOutboxWorker } from "@procella/github";
import { ZodError } from "zod";
import { logger } from "./logger.js";

function handleFatalError(err: unknown): never {
	if (err instanceof ZodError) {
		logger.fatal(`Invalid Procella configuration:\n\n${formatConfigErrors(err)}`);
	} else {
		logger.fatal(err instanceof Error ? { err } : { err: String(err) }, "Fatal startup error");
	}
	logger.flush();
	process.exit(1);
}

if (process.argv.includes("--healthz")) {
	const port = (process.env.PROCELLA_LISTEN_ADDR ?? ":9090").split(":").pop() || "9090";
	fetch(`http://localhost:${port}/healthz`)
		.then((res) => process.exit(res.ok ? 0 : 1))
		.catch(() => process.exit(1));
} else if (process.argv.includes("--migrate")) {
	try {
		const { loadConfig } = await import("@procella/config");
		const { runMigrations } = await import("@procella/db");
		const config = loadConfig();
		const nextArg = process.argv[process.argv.indexOf("--migrate") + 1];
		const migrationsFolder = nextArg && !nextArg.startsWith("-") ? nextArg : "./migrations";
		logger.info({ migrationsFolder }, "Running migrations...");
		await runMigrations(config.databaseUrl, migrationsFolder);
		logger.info("Migrations complete.");
		logger.flush();
		process.exit(0);
	} catch (err) {
		handleFatalError(err);
	}
} else {
	try {
		const { existsSync } = await import("node:fs");
		const { withInternalClientIp } = await import("./middleware/security.js");
		const { shutdownTelemetry } = await import("@procella/telemetry");
		const { GCWorker } = await import("@procella/updates");
		const { bootstrap } = await import("./bootstrap.js");
		const { app, auth, config, db, client, github } = await bootstrap();

		const uiRoot = process.env.PROCELLA_UI_PATH || "/ui";
		if (existsSync(`${uiRoot}/index.html`)) {
			const { serveStatic } = await import("hono/bun");
			app.get("*", serveStatic({ root: uiRoot }));
			app.get("*", (c, next) => {
				const p = c.req.path;
				if (p.startsWith("/api/") || p.startsWith("/trpc/")) return next();
				return serveStatic({ root: uiRoot, path: "/index.html" })(c, next);
			});
		}

		const [, portStr] = config.listenAddr.split(":");
		const port = Number.parseInt(portStr || "9090", 10);

		const server = Bun.serve({
			fetch: (request, server) =>
				app.fetch(withInternalClientIp(request, server.requestIP(request)?.address)),
			port,
			hostname: "0.0.0.0",
		});

		logger.info({ host: server.hostname, port: server.port }, "Procella listening");

		const gc = new GCWorker({ db });
		void gc.start();
		const githubOutbox = github ? new GitHubOutboxWorker({ db, github }) : null;
		if (githubOutbox) void githubOutbox.start();

		const DRAIN_TIMEOUT_MS = 10_000;
		const shutdown = async () => {
			const forceTimer = setTimeout(() => {
				server.stop(true);
				void client.close();
				process.exit(1);
			}, DRAIN_TIMEOUT_MS);
			forceTimer.unref();

			await server.stop();
			await gc.stop();
			if (githubOutbox) await githubOutbox.stop();
			await shutdownTelemetry();
			auth.dispose?.();
			await client.close();
			clearTimeout(forceTimer);
			process.exit(0);
		};
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);
	} catch (err) {
		handleFatalError(err);
	}
}
