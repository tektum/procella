// E2E — State operations: export empty stack, export after up, import roundtrip.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import {
	apiRequest,
	BACKEND_URL,
	cleanupDir,
	createPulumiHome,
	newProjectDir,
	pulumi,
	truncateTables,
} from "./helpers.js";

const RANDOM_PET_PROGRAM = `name: state-proj
runtime: yaml
resources:
  pet:
    type: random:index:RandomPet
    properties:
      length: 2
outputs:
  petName: \${pet.id}
`;

describe("state operations", () => {
	let pulumiHome: string;
	let projectDir: string;
	let importUpdateId: string;

	beforeAll(async () => {
		pulumiHome = await createPulumiHome();
		await pulumi(["login", "--cloud-url", BACKEND_URL], { pulumiHome });
	});

	afterAll(async () => {
		if (projectDir) await cleanupDir(projectDir);
		await cleanupDir(pulumiHome);
		await truncateTables();
	});

	test("export empty stack returns valid deployment", async () => {
		await apiRequest("/stacks/dev-org/state-proj/empty", { method: "POST" });
		const res = await apiRequest("/stacks/dev-org/state-proj/empty/export");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("version");
		expect(body.version).toBe(3);
		expect(body).toHaveProperty("deployment");
	});

	test("export after pulumi up returns resources", async () => {
		projectDir = await newProjectDir("state-test");
		await Bun.write(path.join(projectDir, "Pulumi.yaml"), RANDOM_PET_PROGRAM);

		const initRes = await pulumi(["stack", "init", "dev-org/state-proj/with-resources"], {
			cwd: projectDir,
			pulumiHome,
		});
		expect(initRes.exitCode).toBe(0);

		const upRes = await pulumi(["up", "--yes"], { cwd: projectDir, pulumiHome });
		expect(upRes.exitCode).toBe(0);

		const exportRes = await apiRequest("/stacks/dev-org/state-proj/with-resources/export");
		expect(exportRes.status).toBe(200);
		const body = await exportRes.json();
		expect(body.deployment).toBeDefined();
		expect(body.deployment.resources).toBeArray();
		expect(body.deployment.resources.length).toBeGreaterThan(0);
	});

	test("export + import roundtrip", async () => {
		const exportRes = await apiRequest("/stacks/dev-org/state-proj/with-resources/export");
		const deployment = await exportRes.json();

		const importRes = await apiRequest("/stacks/dev-org/state-proj/with-resources/import", {
			method: "POST",
			body: deployment,
		});
		expect(importRes.status).toBe(200);
		const result = await importRes.json();
		expect(result).toHaveProperty("updateId");

		// Direct API import/export is an opaque JSON-value round trip.
		const reExportRes = await apiRequest("/stacks/dev-org/state-proj/with-resources/export");
		expect(reExportRes.status).toBe(200);
		expect(await reExportRes.json()).toEqual(deployment);
	});

	test("import/export preserves uncommon, duplicate, secret, and future state", async () => {
		await apiRequest("/stacks/dev-org/state-proj/opaque-roundtrip", { method: "POST" });
		const duplicateUrn = "urn:pulumi:dev::state-proj::test:index:Resource::duplicate";
		const deployment = {
			version: 3,
			deployment: {
				manifest: { time: "2026-09-15T00:00:00.000Z", magic: "opaque", version: "3.260.0" },
				secrets_providers: { type: "passphrase", state: { salt: "v1:test-salt" } },
				resources: [
					{
						urn: duplicateUrn,
						custom: true,
						type: "test:index:Resource",
						id: "old",
						delete: true,
						aliases: [`${duplicateUrn}-old`],
						additionalSecretOutputs: ["password"],
						outputs: {
							password: {
								"4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270",
								ciphertext: "opaque-test-ciphertext",
							},
						},
						future_resource_field: false,
					},
					{
						urn: duplicateUrn,
						custom: true,
						type: "test:index:Resource",
						id: "new",
						pendingReplacement: true,
						retainOnDelete: true,
					},
				],
				pending_operations: [
					{
						resource: {
							urn: "urn:pulumi:dev::state-proj::test:index:Resource::pending",
							custom: true,
							type: "test:index:Resource",
							inputs: { preserve: [] },
						},
						type: "creating",
					},
				],
				metadata: { future_field: { preserve: true } },
				future_deployment_field: false,
			},
		};

		const importRes = await apiRequest("/stacks/dev-org/state-proj/opaque-roundtrip/import", {
			method: "POST",
			body: deployment,
		});
		expect(importRes.status).toBe(200);

		const exportRes = await apiRequest("/stacks/dev-org/state-proj/opaque-roundtrip/export");
		expect(exportRes.status).toBe(200);
		expect(await exportRes.json()).toEqual(deployment);
	});

	test("import to fresh stack", async () => {
		await apiRequest("/stacks/dev-org/state-proj/import-target", { method: "POST" });

		const exportRes = await apiRequest("/stacks/dev-org/state-proj/with-resources/export");
		const deployment = await exportRes.json();

		const importRes = await apiRequest("/stacks/dev-org/state-proj/import-target/import", {
			method: "POST",
			body: deployment,
		});
		expect(importRes.status).toBe(200);
		const result = await importRes.json();
		expect(result).toHaveProperty("updateId");
		importUpdateId = result.updateId;
	});

	test("get update status after import returns succeeded", async () => {
		const res = await apiRequest(
			`/stacks/dev-org/state-proj/import-target/update/${importUpdateId}`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("succeeded");
	});
});
