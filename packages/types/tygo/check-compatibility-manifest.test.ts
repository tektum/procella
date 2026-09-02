import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateCompatibilityManifest } from "../src/compatibility.js";
import { PulumiRoutes } from "../src/routes.gen.js";
import { extractUpstreamCapabilities } from "./check-compatibility-manifest.js";

const PULUMI_GEN_FILE = resolve(import.meta.dir, "../src/pulumi.gen.ts");

describe("check-compatibility-manifest", () => {
	test("the currently generated pulumi.gen.ts and routes.gen.ts pass with no drift", () => {
		const pulumiGenSource = readFileSync(PULUMI_GEN_FILE, "utf8");
		const capabilities = extractUpstreamCapabilities(pulumiGenSource);
		const routes = Object.keys(PulumiRoutes);

		// Sanity: the extraction actually found the real generated inventories,
		// so a passing result below isn't a false positive from empty lists.
		expect(capabilities.length).toBeGreaterThan(0);
		expect(routes.length).toBeGreaterThan(0);

		const errors = validateCompatibilityManifest({ capabilities, routes });
		expect(errors).toEqual([]);
	});

	test("extraction finds every generated APICapability value, including begin-update", () => {
		const pulumiGenSource = readFileSync(PULUMI_GEN_FILE, "utf8");
		const capabilities = extractUpstreamCapabilities(pulumiGenSource);

		expect(capabilities).toContain("begin-update");
		expect(capabilities).toContain("api-version");
		expect(capabilities).toContain("batch-encrypt");
		expect(capabilities).toContain("delta-checkpoint-uploads-v2");
	});

	test("a synthetic unclassified capability injected into the real inventory fails and is named", () => {
		const pulumiGenSource = readFileSync(PULUMI_GEN_FILE, "utf8");
		const capabilities = extractUpstreamCapabilities(pulumiGenSource);
		const routes = Object.keys(PulumiRoutes);

		const errors = validateCompatibilityManifest({
			capabilities: [...capabilities, "some-unseen-future-capability"],
			routes,
		});

		expect(errors.length).toBeGreaterThan(0);
		expect(errors).toContain(
			'missing capability classification: "some-unseen-future-capability" is generated upstream but has no policy entry',
		);
	});

	test("a synthetic unclassified route injected into the real inventory fails and is named", () => {
		const pulumiGenSource = readFileSync(PULUMI_GEN_FILE, "utf8");
		const capabilities = extractUpstreamCapabilities(pulumiGenSource);
		const routes = Object.keys(PulumiRoutes);

		const errors = validateCompatibilityManifest({
			capabilities,
			routes: [...routes, "someUnseenFutureRoute"],
		});

		expect(errors.length).toBeGreaterThan(0);
		expect(errors).toContain(
			'missing route classification: "someUnseenFutureRoute" is generated upstream but has no policy entry',
		);
	});
});
