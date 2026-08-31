// E2E — Journaling protocol: startUpdate echoes journalVersion, full lifecycle.

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

const RANDOM_PET_PROGRAM = `name: journaling-test
runtime: yaml
resources:
  pet:
    type: random:index:RandomPet
    properties:
      length: 2
outputs:
  petName: \${pet.id}
`;

const INITIAL_DEPENDENCY_PROGRAM = `name: journal-order
runtime: yaml
resources:
  domain:
    type: random:index:RandomPet
    properties:
      length: 2
      prefix: api-
`;

const UPDATED_DEPENDENCY_PROGRAM = `name: journal-order
runtime: yaml
resources:
  dnsValidation:
    type: random:index:RandomPet
    properties:
      length: 2
      prefix: dns-
  certificate:
    type: random:index:RandomPet
    properties:
      length: 2
      prefix: \${dnsValidation.id}-
  domain:
    type: random:index:RandomPet
    properties:
      length: 2
      prefix: \${certificate.id}-
`;

describe("journaling protocol", () => {
	let pulumiHome: string;
	let projectDir: string;

	beforeAll(async () => {
		pulumiHome = await createPulumiHome();
		await pulumi(["login", "--cloud-url", BACKEND_URL], { pulumiHome });
	});

	afterAll(async () => {
		if (projectDir) await cleanupDir(projectDir);
		await cleanupDir(pulumiHome);
		await truncateTables();
	});

	test("startUpdate echoes journalVersion when client requests it", async () => {
		projectDir = await newProjectDir("journaling-test");
		await Bun.write(path.join(projectDir, "Pulumi.yaml"), RANDOM_PET_PROGRAM);

		const initRes = await pulumi(["stack", "init", "dev-org/journaling-test/dev"], {
			cwd: projectDir,
			pulumiHome,
		});
		expect(initRes.exitCode).toBe(0);

		const createRes = await apiRequest("/stacks/dev-org/journaling-test/dev/update", {
			method: "POST",
			body: {},
		});
		expect(createRes.status).toBe(200);
		const { updateID } = await createRes.json();

		const startRes = await apiRequest(`/stacks/dev-org/journaling-test/dev/update/${updateID}`, {
			method: "POST",
			body: { journalVersion: 1 },
		});
		expect(startRes.status).toBe(200);
		const startBody = await startRes.json();
		expect(startBody.journalVersion).toBe(1);

		await apiRequest(`/stacks/dev-org/journaling-test/dev/update/${updateID}/cancel`, {
			method: "POST",
		});
	});

	test("pulumi up + destroy work with journaling active", async () => {
		const upDir = await newProjectDir("journal-compat");
		await Bun.write(path.join(upDir, "Pulumi.yaml"), RANDOM_PET_PROGRAM);
		try {
			const initRes = await pulumi(["stack", "init", "dev-org/journaling-test/compat"], {
				cwd: upDir,
				pulumiHome,
			});
			expect(initRes.exitCode).toBe(0);

			const upRes = await pulumi(["up", "--yes"], { cwd: upDir, pulumiHome });
			expect(upRes.exitCode).toBe(0);

			const destroyRes = await pulumi(["destroy", "--yes"], { cwd: upDir, pulumiHome });
			expect(destroyRes.exitCode).toBe(0);
		} finally {
			await cleanupDir(upDir);
		}
	});

	test("updated resources remain after their newly-created dependencies", async () => {
		const orderDir = await newProjectDir("journal-order");
		await Bun.write(path.join(orderDir, "Pulumi.yaml"), INITIAL_DEPENDENCY_PROGRAM);
		try {
			const init = await pulumi(["stack", "init", "dev-org/journal-order/dev"], {
				cwd: orderDir,
				pulumiHome,
			});
			expect(init.exitCode).toBe(0);

			const initialUp = await pulumi(["up", "--yes"], { cwd: orderDir, pulumiHome });
			expect(initialUp.exitCode).toBe(0);

			await Bun.write(path.join(orderDir, "Pulumi.yaml"), UPDATED_DEPENDENCY_PROGRAM);
			const dependencyUp = await pulumi(["up", "--yes"], { cwd: orderDir, pulumiHome });
			expect(dependencyUp.exitCode).toBe(0);

			const preview = await pulumi(["preview", "--refresh"], { cwd: orderDir, pulumiHome });
			expect(preview.exitCode).toBe(0);

			const exported = await pulumi(["stack", "export"], { cwd: orderDir, pulumiHome });
			expect(exported.exitCode).toBe(0);
			const deployment = JSON.parse(exported.stdout) as {
				deployment: { resources: Array<{ urn: string; dependencies?: string[] }> };
			};
			const positions = new Map(
				deployment.deployment.resources.map((resource, index) => [resource.urn, index]),
			);
			for (const [index, resource] of deployment.deployment.resources.entries()) {
				for (const dependency of resource.dependencies ?? []) {
					expect(positions.get(dependency)).toBeLessThan(index);
				}
			}
		} finally {
			await cleanupDir(orderDir);
		}
	});
});
