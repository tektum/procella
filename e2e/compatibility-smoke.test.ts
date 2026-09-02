// E2E — Version-aware Pulumi CLI compatibility smoke lanes.
//
// Legacy and minimum lanes share an empty Node.js program whose Pulumi SDK is
// linked directly from the checked-out workspace. This avoids YAML runtime
// incompatibility, provider plugins, network installs, and fake CLI commands.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { PULUMI_FULLY_SUPPORTED_MIN_VERSION, PULUMI_LEGACY_SMOKE_VERSION } from "@procella/types";
import { z } from "zod/v4";
import {
	apiRequest,
	BACKEND_URL,
	cleanupDir,
	createPulumiHome,
	newProjectDir,
	PROJECT_ROOT,
	type PulumiOpts,
	type PulumiResult,
	pulumi,
	truncateTables,
} from "./helpers.js";

type CompatibilityLane = "legacy" | "minimum" | "latest";

const requestedLane = process.env.PROCELLA_PULUMI_COMPATIBILITY_LANE;
const compatibilityLanes: Record<CompatibilityLane, true> = {
	legacy: true,
	minimum: true,
	latest: true,
};
function isCompatibilityLane(value: string): value is CompatibilityLane {
	return value in compatibilityLanes;
}
if (requestedLane !== undefined && !isCompatibilityLane(requestedLane)) {
	throw new Error(`Unknown PROCELLA_PULUMI_COMPATIBILITY_LANE: ${requestedLane}`);
}
const lane = requestedLane;
const describeCompatibility = lane === undefined ? describe.skip : describe;

const EMPTY_NODE_PROGRAM = `const pulumi = require("@pulumi/pulumi");
exports.compatibility = pulumi.output("verified");
`;

const MODERN_PROGRAM = `name: compatibility-smoke
runtime: yaml
outputs:
  compatibility: verified
`;

const StateExport = z.object({
	version: z.number(),
	deployment: z.object({ resources: z.array(z.unknown()) }),
});
const BatchEncryptResponse = z.object({ ciphertexts: z.array(z.string()) });
const BatchDecryptResponse = z.object({ plaintexts: z.record(z.string(), z.string()) });
const CreateUpdateResponse = z.object({ updateID: z.string() });
const StartUpdateResponse = z.object({ journalVersion: z.number().optional() });

function assertNoUnsupportedMediaType(result: PulumiResult): void {
	const output = `${result.stdout}\n${result.stderr}`;
	expect(output).not.toMatch(
		/\b(?:http\s+)?status(?:\s+code)?\s*:?\s*415\b|\b415\s+unsupported media type\b/i,
	);
	expect(output.toLowerCase()).not.toContain("unsupported media type");
}

async function runPulumi(args: string[], opts: PulumiOpts): Promise<PulumiResult> {
	const result = await pulumi(args, opts);
	assertNoUnsupportedMediaType(result);
	expect(result.exitCode).toBe(0);
	return result;
}

function expectApiStatus(response: Response, expected: number): void {
	expect(response.status).not.toBe(415);
	expect(response.status).toBe(expected);
}

function parseVersion(output: string): [number, number, number] {
	const match = output.match(/v?(\d+)\.(\d+)\.(\d+)/);
	if (!match) throw new Error(`Could not parse Pulumi CLI version from: ${output}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
	return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

async function newEmptyNodeProjectDir(name: string): Promise<string> {
	const dir = await newProjectDir(name, "nodejs");
	const dependencyPath = path.join(PROJECT_ROOT, "node_modules", "@pulumi", "pulumi");
	const dependencyLinkDir = path.join(dir, "node_modules", "@pulumi");
	await mkdir(dependencyLinkDir, { recursive: true });
	await symlink(dependencyPath, path.join(dependencyLinkDir, "pulumi"), "dir");
	await Bun.write(
		path.join(dir, "package.json"),
		JSON.stringify(
			{
				name,
				private: true,
				main: "index.js",
				dependencies: { "@pulumi/pulumi": `file:${dependencyPath}` },
			},
			null,
			2,
		),
	);
	await Bun.write(path.join(dir, "index.js"), EMPTY_NODE_PROGRAM);
	return dir;
}

async function cancelDirectUpdate(stackPath: string, accept: string | null): Promise<void> {
	const createUpdate = await apiRequest(`/stacks/${stackPath}/update`, {
		method: "POST",
		body: {},
		accept,
	});
	expectApiStatus(createUpdate, 200);
	const { updateID } = CreateUpdateResponse.parse(await createUpdate.json());
	const startUpdate = await apiRequest(`/stacks/${stackPath}/update/${updateID}`, {
		method: "POST",
		body: {},
		accept,
	});
	expectApiStatus(startUpdate, 200);
	const cancelUpdate = await apiRequest(`/stacks/${stackPath}/update/${updateID}/cancel`, {
		method: "POST",
		accept,
	});
	expectApiStatus(cancelUpdate, 204);
}

async function runCommonCompatibilityChecks(args: {
	projectDir: string;
	pulumiHome: string;
	projectName: string;
	stackName: string;
}): Promise<{ opts: PulumiOpts; stackPath: string }> {
	const { projectDir, pulumiHome, projectName, stackName } = args;
	const opts = { cwd: projectDir, pulumiHome };
	const stackPath = `dev-org/${projectName}/${stackName}`;

	await runPulumi(["login", "--cloud-url", BACKEND_URL], opts);
	await runPulumi(["whoami"], opts);
	await runPulumi(["stack", "init", stackPath], opts);

	const list = await runPulumi(["stack", "ls"], opts);
	expect(list.stdout).toContain(stackName);
	await runPulumi(["stack", "select", stackPath], opts);

	await runPulumi(
		["config", "set", "--secret", "compatibilitySecret", "compatibility-value"],
		opts,
	);
	const secret = await runPulumi(["config", "get", "compatibilitySecret"], opts);
	expect(secret.stdout.trim()).toBe("compatibility-value");

	await runPulumi(["preview"], opts);
	await runPulumi(["up", "--yes"], opts);
	await runPulumi(["refresh", "--yes"], opts);

	const initialExport = path.join(projectDir, "initial-state.json");
	await runPulumi(["stack", "export", "--file", initialExport], opts);
	const initialState = StateExport.parse(await Bun.file(initialExport).json());
	expect(initialState.version).toBe(3);

	// Direct create/start/cancel coverage stays outside the CLI's signal timing.
	await cancelDirectUpdate(stackPath, null);
	await runPulumi(["destroy", "--yes"], opts);

	await runPulumi(["stack", "import", "--file", initialExport], opts);

	const roundtripExport = path.join(projectDir, "roundtrip-state.json");
	await runPulumi(["stack", "export", "--file", roundtripExport], opts);
	const roundtripState = StateExport.parse(await Bun.file(roundtripExport).json());
	expect(roundtripState.version).toBe(3);
	expect(roundtripState.deployment.resources).toEqual(initialState.deployment.resources);

	for (const route of ["/user", "/stacks", `/stacks/${stackPath}/export`]) {
		const response = await apiRequest(route, { accept: null });
		expectApiStatus(response, 200);
	}

	return { opts, stackPath };
}

describeCompatibility("Pulumi CLI compatibility smoke", () => {
	let pulumiHome: string;
	let projectDir: string | undefined;

	beforeAll(async () => {
		pulumiHome = await createPulumiHome();
	});

	afterAll(async () => {
		if (projectDir) await cleanupDir(projectDir);
		if (pulumiHome) await cleanupDir(pulumiHome);
		await truncateTables();
	});

	test("uses the CLI version selected for the compatibility lane", async () => {
		const result = await runPulumi(["version"], { pulumiHome });
		const actual = parseVersion(`${result.stdout}\n${result.stderr}`);
		if (lane === "legacy") {
			expect(actual).toEqual(parseVersion(PULUMI_LEGACY_SMOKE_VERSION));
		} else if (lane === "minimum") {
			expect(actual).toEqual(parseVersion(PULUMI_FULLY_SUPPORTED_MIN_VERSION));
		} else {
			expect(
				compareVersions(actual, parseVersion(PULUMI_FULLY_SUPPORTED_MIN_VERSION)),
			).toBeGreaterThanOrEqual(0);
		}
	});

	test.skipIf(lane !== "legacy")(
		"v3.9 runs common lifecycle and protocol checks with an empty Node.js program",
		async () => {
			const projectName = "compatibility-legacy";
			projectDir = await newEmptyNodeProjectDir(projectName);
			const { opts, stackPath } = await runCommonCompatibilityChecks({
				projectDir,
				pulumiHome,
				projectName,
				stackName: "dev",
			});
			await runPulumi(["stack", "rm", "--yes", stackPath], opts);
		},
	);

	test.skipIf(lane !== "minimum")(
		"minimum-supported CLI adds API v9, batch crypto, and journaling to common checks",
		async () => {
			const projectName = "compatibility-minimum";
			projectDir = await newEmptyNodeProjectDir(projectName);
			const { opts, stackPath } = await runCommonCompatibilityChecks({
				projectDir,
				pulumiHome,
				projectName,
				stackName: "minimum",
			});

			const capabilities = await apiRequest("/capabilities", {
				accept: "application/vnd.pulumi+9",
			});
			expectApiStatus(capabilities, 200);

			const plaintexts = [btoa("compatibility-one"), btoa("compatibility-two")];
			const encrypt = await apiRequest(`/stacks/${stackPath}/batch-encrypt`, {
				method: "POST",
				body: { plaintexts },
				accept: "application/vnd.pulumi+9",
			});
			expectApiStatus(encrypt, 200);
			const { ciphertexts } = BatchEncryptResponse.parse(await encrypt.json());
			expect(ciphertexts).toHaveLength(2);

			const decrypt = await apiRequest(`/stacks/${stackPath}/batch-decrypt`, {
				method: "POST",
				body: { ciphertexts },
				accept: "application/vnd.pulumi+9",
			});
			expectApiStatus(decrypt, 200);
			const decrypted = BatchDecryptResponse.parse(await decrypt.json());
			for (let index = 0; index < ciphertexts.length; index++) {
				expect(decrypted.plaintexts[ciphertexts[index]]).toBe(plaintexts[index]);
			}

			const createUpdate = await apiRequest(`/stacks/${stackPath}/update`, {
				method: "POST",
				body: {},
				accept: "application/vnd.pulumi+9",
			});
			expectApiStatus(createUpdate, 200);
			const { updateID } = CreateUpdateResponse.parse(await createUpdate.json());
			const startUpdate = await apiRequest(`/stacks/${stackPath}/update/${updateID}`, {
				method: "POST",
				body: { journalVersion: 1 },
				accept: "application/vnd.pulumi+9",
			});
			expectApiStatus(startUpdate, 200);
			expect(StartUpdateResponse.parse(await startUpdate.json()).journalVersion).toBe(1);
			const cancelUpdate = await apiRequest(`/stacks/${stackPath}/update/${updateID}/cancel`, {
				method: "POST",
				accept: "application/vnd.pulumi+9",
			});
			expectApiStatus(cancelUpdate, 204);

			await runPulumi(["stack", "rm", "--yes", stackPath], opts);
		},
	);

	test.skipIf(lane !== "latest")(
		"latest canary stays bounded to login, init, preview, up, export, destroy, and removal",
		async () => {
			projectDir = await newProjectDir("compatibility-latest");
			await Bun.write(path.join(projectDir, "Pulumi.yaml"), MODERN_PROGRAM);
			const opts = { cwd: projectDir, pulumiHome };
			const stackPath = "dev-org/compatibility-smoke/latest";

			await runPulumi(["login", "--cloud-url", BACKEND_URL], opts);
			await runPulumi(["stack", "init", stackPath], opts);
			await runPulumi(["preview"], opts);
			await runPulumi(["up", "--yes"], opts);

			const exportPath = path.join(projectDir, "latest-state.json");
			await runPulumi(["stack", "export", "--file", exportPath], opts);
			expect(StateExport.parse(await Bun.file(exportPath).json()).version).toBe(3);

			await runPulumi(["destroy", "--yes"], opts);
			await runPulumi(["stack", "rm", "--yes", stackPath], opts);
		},
	);
});
