// E2E: stack-managed ESC environments with the real Pulumi CLI (`pulumi stack init --esc-config`,
// experimental since v3.276.0). Covers creation, plain and secret config stored in the stack's
// environment, an update evaluated against a draft, and environment removal with the stack.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { SQL } from "bun";
import {
	apiRequest,
	cleanupDir,
	createPulumiHome,
	newProjectDir,
	type PulumiOpts,
	pulumi,
	TEST_DB_URL,
	truncateTables,
} from "./helpers.js";

const PROJECT = "managed-esc";
const STACK = `dev-org/${PROJECT}/dev`;

/** `--esc-config` is hidden unless PULUMI_EXPERIMENTAL is set and needs CLI v3.276.0+. */
async function cliSupportsEscConfig(): Promise<boolean> {
	const proc = Bun.spawn(["pulumi", "stack", "init", "--help"], {
		env: { ...process.env, PULUMI_EXPERIMENTAL: "true" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
	await proc.exited;
	return out.includes("--esc-config");
}

describe.skipIf(!(await cliSupportsEscConfig()))("stack-managed ESC environments", () => {
	let projectDir: string;
	let pulumiHome: string;
	let opts: PulumiOpts;

	beforeAll(async () => {
		await truncateTables();
		projectDir = await newProjectDir(PROJECT);
		await Bun.write(
			path.join(projectDir, "Pulumi.yaml"),
			[
				`name: ${PROJECT}`,
				"runtime: yaml",
				"config:",
				"  greeting:",
				"    type: string",
				"  password:",
				"    type: string",
				"outputs:",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: Pulumi YAML interpolation
				"  greeting: ${greeting}",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: Pulumi YAML interpolation
				"  password: ${password}",
				"",
			].join("\n"),
		);
		pulumiHome = await createPulumiHome();
		opts = { cwd: projectDir, pulumiHome, env: { PULUMI_EXPERIMENTAL: "true" } };
	});

	afterAll(async () => {
		await cleanupDir(projectDir);
		await cleanupDir(pulumiHome);
	});

	test("stack init --esc-config creates the stack and its environment", async () => {
		const res = await pulumi(["stack", "init", STACK, "--esc-config"], opts);
		expect(res.exitCode, res.stderr).toBe(0);

		const stack = await apiRequest(`/stacks/dev-org/${PROJECT}/dev`);
		expect(stack.status).toBe(200);
		expect((await stack.json()).managedEnvironment).toBe(`${PROJECT}/dev`);

		const env = await apiRequest(`/esc/environments/dev-org/${PROJECT}/dev`);
		expect(env.status).toBe(200);
		expect(await env.text()).toContain("pulumiConfig");

		const stackFile = await Bun.file(path.join(projectDir, "Pulumi.dev.yaml")).text();
		expect(stackFile).toContain("pulumiConfig");
	});

	test("config set writes plain and secret values into the stack file's environment", async () => {
		const plain = await pulumi(["config", "set", "greeting", "hello"], opts);
		expect(plain.exitCode, plain.stderr).toBe(0);
		const secret = await pulumi(["config", "set", "--secret", "password", "s3cret"], opts);
		expect(secret.exitCode, secret.stderr).toBe(0);

		const stackFile = await Bun.file(path.join(projectDir, "Pulumi.dev.yaml")).text();
		expect(stackFile).toContain("greeting: hello");
		expect(stackFile).toContain("ciphertext:");
		expect(stackFile).not.toContain("s3cret");
	});

	test("up evaluates a draft of the environment and pins it on the update", async () => {
		const up = await pulumi(["up", "--yes", "--skip-preview"], opts);
		expect(up.exitCode, `${up.stdout}\n${up.stderr}`).toBe(0);

		const greeting = await pulumi(["stack", "output", "greeting"], opts);
		expect(greeting.stdout.trim()).toBe("hello");
		const password = await pulumi(["stack", "output", "password", "--show-secrets"], opts);
		expect(password.stdout.trim()).toBe("s3cret");

		const sql = new SQL({ url: TEST_DB_URL });
		try {
			const rows = await sql`
				SELECT u.managed_environment FROM updates u
				JOIN stacks s ON s.id = u.stack_id
				WHERE s.name = 'dev' AND u.kind = 'update'
				ORDER BY u.created_at DESC LIMIT 1`;
			// Drizzle stores jsonb columns as JSON strings in this database (true of every jsonb
			// column, e.g. updates.config); decode the way the app's drizzle reads do.
			const raw = rows[0]?.managed_environment;
			const pin = (typeof raw === "string" ? JSON.parse(raw) : raw) as
				| { baseRevision: number; changeRequestID?: string; draftRevision: number }
				| undefined;
			expect(pin?.baseRevision).toBeGreaterThanOrEqual(1);
			expect(pin?.changeRequestID).toBeTruthy();
			expect(pin?.draftRevision).toBe(0);
		} finally {
			await sql.close();
		}
	});

	test("stack rm deletes the managed environment", async () => {
		const destroy = await pulumi(["destroy", "--yes", "--skip-preview"], opts);
		expect(destroy.exitCode, destroy.stderr).toBe(0);
		const rm = await pulumi(["stack", "rm", "--yes", STACK], opts);
		expect(rm.exitCode, rm.stderr).toBe(0);

		expect((await apiRequest(`/esc/environments/dev-org/${PROJECT}/dev`)).status).toBe(404);
	});
});
