import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPECTED_SUCCESS_MESSAGE = "Migrations complete";

export function resolveMigrationCommandDirectory(
	environment: Record<string, string | undefined>,
): string {
	return environment.GITHUB_WORKSPACE?.trim() || "../..";
}

export interface MigrationInvocationOptions {
	awsExecutable?: string;
	env?: Record<string, string | undefined>;
	temporaryRoot?: string;
}

function parseJson(value: string, label: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new Error(`Migration Lambda returned invalid ${label} JSON`);
	}
}

export function validateMigrationInvocation(metadataText: string, payloadText: string): string {
	const metadata = parseJson(metadataText, "invocation metadata");
	const payload = parseJson(payloadText, "payload");

	if (
		typeof metadata !== "object" ||
		metadata === null ||
		Array.isArray(metadata) ||
		!("StatusCode" in metadata) ||
		metadata.StatusCode !== 200
	) {
		throw new Error("Migration Lambda invocation did not return HTTP status 200");
	}
	if ("FunctionError" in metadata) {
		throw new Error("Migration Lambda reported a function error");
	}
	if (
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload) ||
		!("status" in payload) ||
		payload.status !== "ok" ||
		!("message" in payload) ||
		payload.message !== EXPECTED_SUCCESS_MESSAGE
	) {
		throw new Error("Migration Lambda did not return the expected success result");
	}

	return EXPECTED_SUCCESS_MESSAGE;
}

export async function invokeMigration(
	region: string,
	functionName: string,
	options: MigrationInvocationOptions = {},
): Promise<string> {
	const outputDirectory = await mkdtemp(
		join(options.temporaryRoot ?? tmpdir(), "procella-migrate-"),
	);
	const outputPath = join(outputDirectory, "response.json");
	try {
		const invocation = Bun.spawn(
			[
				options.awsExecutable ?? "aws",
				"lambda",
				"invoke",
				"--region",
				region,
				"--function-name",
				functionName,
				"--payload",
				"{}",
				"--cli-binary-format",
				"raw-in-base64-out",
				"--cli-read-timeout",
				"360",
				outputPath,
			],
			{ env: options.env, stdout: "pipe", stderr: "pipe" },
		);
		const [metadataText, stderrText, exitCode] = await Promise.all([
			new Response(invocation.stdout).text(),
			new Response(invocation.stderr).text(),
			invocation.exited,
		]);
		if (exitCode !== 0) {
			throw new Error(
				stderrText.trim() || `AWS Lambda invocation failed with exit code ${exitCode}`,
			);
		}

		const payloadText = await Bun.file(outputPath).text();
		return validateMigrationInvocation(metadataText, payloadText);
	} finally {
		await rm(outputDirectory, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const [region, functionName] = Bun.argv.slice(2);
	if (!region || !functionName) {
		console.error("Usage: bun run scripts/invoke-migration-lambda.ts <region> <function-name>");
		process.exitCode = 2;
	} else {
		try {
			console.log(await invokeMigration(region, functionName));
		} catch (error) {
			console.error(error instanceof Error ? error.message : "Migration Lambda invocation failed");
			process.exitCode = 1;
		}
	}
}
