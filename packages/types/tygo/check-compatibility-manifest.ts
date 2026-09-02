#!/usr/bin/env bun
// Fail-closed drift check between the generated Pulumi upstream inventories
// (pulumi.gen.ts APICapability consts, routes.gen.ts PulumiRoutes keys) and
// the hand-maintained compatibility manifest in packages/types/src/compatibility.ts.
//
// Exits non-zero and names every missing/extra/duplicate/malformed
// classification. Run via: bun run types:check-compatibility

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	LOCAL_CAPABILITY_EXTENSIONS,
	validateCompatibilityManifest,
} from "../src/compatibility.js";
import { PulumiRoutes } from "../src/routes.gen.js";

const SRC_DIR = resolve(import.meta.dir, "../src");
const PULUMI_GEN_FILE = resolve(SRC_DIR, "pulumi.gen.ts");

// Matches every generated `export const X: APICapability = "value";` line —
// the exhaustive upstream capability inventory tygo produces from apitype's
// service.go. Deliberately does not include the `APICapability` type alias
// itself (`export type APICapability = string;`), only the value consts.
const CAPABILITY_CONST_REGEX = /export const \w+: APICapability = "([^"]+)";/g;

export function extractUpstreamCapabilities(pulumiGenSource: string): string[] {
	return [...pulumiGenSource.matchAll(CAPABILITY_CONST_REGEX)].map((match) => match[1]);
}

function main() {
	const pulumiGenSource = readFileSync(PULUMI_GEN_FILE, "utf8");
	const capabilities = extractUpstreamCapabilities(pulumiGenSource);
	const routes = Object.keys(PulumiRoutes);

	const errors = validateCompatibilityManifest({ capabilities, routes });

	if (errors.length > 0) {
		console.error(`Pulumi compatibility manifest check FAILED (${errors.length} issue(s)):`);
		for (const error of errors) {
			console.error(`  - ${error}`);
		}
		process.exit(1);
	}

	process.stdout.write(
		`OK: ${capabilities.length} capabilities, ${routes.length} routes, and ` +
			`${LOCAL_CAPABILITY_EXTENSIONS.length} local extension(s) classified with no drift.\n`,
	);
}

if (import.meta.main) {
	main();
}
