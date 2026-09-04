import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	invokeMigration,
	resolveMigrationCommandDirectory,
	validateMigrationInvocation,
} from "./invoke-migration-lambda.js";

const successPayload = JSON.stringify({ status: "ok", message: "Migrations complete" });

describe("resolveMigrationCommandDirectory", () => {
	test("uses the GitHub Actions workspace absolute path", () => {
		expect(
			resolveMigrationCommandDirectory({
				GITHUB_WORKSPACE: "/home/runner/work/procella/procella",
			}),
		).toBe("/home/runner/work/procella/procella");
	});

	test("walks from .sst/platform to the project root for local deploys", () => {
		expect(resolveMigrationCommandDirectory({})).toBe("../..");
		expect(resolveMigrationCommandDirectory({ GITHUB_WORKSPACE: "  " })).toBe("../..");
	});
});

describe("validateMigrationInvocation", () => {
	test("accepts a successful synchronous migration response", () => {
		expect(validateMigrationInvocation(JSON.stringify({ StatusCode: 200 }), successPayload)).toBe(
			"Migrations complete",
		);
	});

	test("rejects FunctionError even when the payload claims success", () => {
		expect(() =>
			validateMigrationInvocation(
				JSON.stringify({ StatusCode: 200, FunctionError: "Unhandled" }),
				successPayload,
			),
		).toThrow("Migration Lambda reported a function error");
	});

	test("rejects a successful invocation without the expected migration result", () => {
		expect(() =>
			validateMigrationInvocation(
				JSON.stringify({ StatusCode: 200 }),
				JSON.stringify({ errorMessage: "migration failed" }),
			),
		).toThrow("Migration Lambda did not return the expected success result");
	});

	test("rejects non-success invocation status", () => {
		expect(() =>
			validateMigrationInvocation(JSON.stringify({ StatusCode: 202 }), successPayload),
		).toThrow("Migration Lambda invocation did not return HTTP status 200");
	});

	test("rejects malformed invocation output", () => {
		expect(() => validateMigrationInvocation("not-json", successPayload)).toThrow(
			"Migration Lambda returned invalid invocation metadata JSON",
		);
		expect(() =>
			validateMigrationInvocation(JSON.stringify({ StatusCode: 200 }), "not-json"),
		).toThrow("Migration Lambda returned invalid payload JSON");
	});
});

interface InvocationRun {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface FakeAwsContext {
	executable: string;
	env: Record<string, string | undefined>;
	temporaryRoot: string;
}

async function withFakeAws<T>(
	metadata: object,
	payload: object,
	awsExitCode: number,
	run: (context: FakeAwsContext) => Promise<T>,
): Promise<T> {
	const binDir = await mkdtemp(join(tmpdir(), "procella-lambda-invoke-test-"));
	const awsPath = join(binDir, "aws");
	await writeFile(
		awsPath,
		`#!/bin/sh
for output do :; done
printf '%s' "$FAKE_PAYLOAD" > "$output"
printf '%s\\n' "$FAKE_METADATA"
exit "$FAKE_EXIT_CODE"
`,
		{ mode: 0o755 },
	);

	try {
		return await run({
			executable: awsPath,
			temporaryRoot: binDir,
			env: {
				...process.env,
				FAKE_METADATA: JSON.stringify(metadata),
				FAKE_PAYLOAD: JSON.stringify(payload),
				FAKE_EXIT_CODE: String(awsExitCode),
			},
		});
	} finally {
		await rm(binDir, { recursive: true, force: true });
	}
}

async function runInvoker(
	metadata: object,
	payload: object,
	awsExitCode = 0,
): Promise<InvocationRun> {
	return withFakeAws(metadata, payload, awsExitCode, async ({ executable, env }) => {
		const invocation = Bun.spawn(
			[
				process.execPath,
				"run",
				new URL("./invoke-migration-lambda.ts", import.meta.url).pathname,
				"us-east-1",
				"test-migrate-function",
			],
			{
				env: { ...env, PATH: `${join(executable, "..")}:${process.env.PATH ?? ""}` },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(invocation.stdout).text(),
			new Response(invocation.stderr).text(),
			invocation.exited,
		]);
		return { exitCode, stdout, stderr };
	});
}

describe("invokeMigration", () => {
	test("returns the expected result after checking AWS metadata and payload", async () => {
		const result = await withFakeAws(
			{ StatusCode: 200 },
			{ status: "ok", message: "Migrations complete" },
			0,
			async ({ executable, env, temporaryRoot }) => {
				const result = await invokeMigration("us-east-1", "test-migrate-function", {
					awsExecutable: executable,
					env,
					temporaryRoot,
				});
				expect(await readdir(temporaryRoot)).toEqual(["aws"]);
				return result;
			},
		);

		expect(result).toBe("Migrations complete");
	});

	test("rejects FunctionError returned by a successful AWS CLI process", async () => {
		await expect(
			withFakeAws(
				{ StatusCode: 200, FunctionError: "Unhandled" },
				{ errorMessage: "migration failed" },
				0,
				({ executable, env, temporaryRoot }) =>
					invokeMigration("us-east-1", "test-migrate-function", {
						awsExecutable: executable,
						env,
						temporaryRoot,
					}),
			),
		).rejects.toThrow("Migration Lambda reported a function error");
	});

	test("rejects AWS CLI process failure before reading the payload", async () => {
		await expect(
			withFakeAws({}, {}, 7, ({ executable, env, temporaryRoot }) =>
				invokeMigration("us-east-1", "test-migrate-function", {
					awsExecutable: executable,
					env,
					temporaryRoot,
				}),
			),
		).rejects.toThrow("AWS Lambda invocation failed with exit code 7");
	});
});

describe("migration Lambda invocation command", () => {
	test("exits successfully only for the expected Lambda result", async () => {
		const result = await runInvoker(
			{ StatusCode: 200 },
			{ status: "ok", message: "Migrations complete" },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("Migrations complete");
		expect(result.stderr).toBe("");
	});

	test("exits nonzero when Lambda reports FunctionError", async () => {
		const result = await runInvoker(
			{ StatusCode: 200, FunctionError: "Unhandled" },
			{ errorMessage: "migration failed" },
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Migration Lambda reported a function error");
	});

	test("preserves a nonzero AWS CLI exit", async () => {
		const result = await runInvoker({}, {}, 7);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("AWS Lambda invocation failed with exit code 7");
	});
});
