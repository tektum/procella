#!/usr/bin/env bun
// Generate routes.gen.ts from the Pulumi Go SDK source.
//
// Fetches api_endpoints.go (pinned to the SDK version in go.mod) and extracts
// the full route table. Output is a typed constant with method + path for
// every endpoint the CLI expects.
//
// Usage: bun run packages/types/tygo/generate-routes.ts

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TYGO_DIR = import.meta.dir;
const GO_MOD = resolve(TYGO_DIR, "go.mod");
const OUT_FILE = resolve(TYGO_DIR, "../src/routes.gen.ts");

const ENDPOINTS_PATH = "pkg/backend/httpstate/client/api_endpoints.go";

function extractSdkVersion(): string {
	const gomod = readFileSync(GO_MOD, "utf8");
	const match = gomod.match(/github\.com\/pulumi\/pulumi\/sdk\/v3\s+(v[\d.]+)/);
	if (!match) throw new Error("Could not find Pulumi SDK version in go.mod");
	return match[1];
}

function sdkVersionToMonorepoTag(sdkVersion: string): string {
	return `sdk/${sdkVersion}`;
}

export async function fetchGoFile(tag: string, path: string): Promise<string> {
	const url = `https://raw.githubusercontent.com/pulumi/pulumi/${tag}/${path}`;
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(
			`Failed to fetch ${path} from pinned tag ${tag} (HTTP ${res.status} ${res.statusText}). ` +
				"Refusing to fall back to the master branch: routes must be generated from the exact " +
				"Pulumi SDK version pinned in go.mod, or generation must fail closed.",
		);
	}
	return res.text();
}

interface Route {
	method: string;
	path: string;
	name: string;
}

function parseEndpoints(source: string): Route[] {
	const regex = /addEndpoint\("(\w+)",\s*"([^"]+)",\s*"(\w+)"\)/g;
	const routes: Route[] = [];
	for (const match of source.matchAll(regex)) {
		routes.push({ method: match[1], path: match[2], name: match[3] });
	}
	return routes;
}

const PARAM_RENAMES: Record<string, string> = {
	orgName: "org",
	projectName: "project",
	stackName: "stack",
	updateKind: "kind",
	updateID: "updateId",
};

function goPathToHono(path: string): string {
	return path.replace(/\{(\w+)(?::.*?)?\}/g, (_, name) => `:${PARAM_RENAMES[name] ?? name}`);
}

function generateTs(routes: Route[], sdkVersion: string): string {
	const lines = [
		`// Auto-generated from pulumi/pulumi ${ENDPOINTS_PATH}`,
		`// Pulumi SDK ${sdkVersion} — do not edit manually.`,
		`// Regenerate: bun run packages/types/tygo/generate-routes.ts`,
		"",
		'type Method = "GET" | "POST" | "PATCH" | "DELETE";',
		"",
		"export const PulumiRoutes = {",
	];

	for (const r of routes) {
		const honoPath = goPathToHono(r.path);
		lines.push(`  ${r.name}: { method: "${r.method}" as Method, path: "${honoPath}" },`);
	}

	lines.push("} as const;");
	lines.push("");
	lines.push("export type PulumiRouteName = keyof typeof PulumiRoutes;");
	lines.push("");

	return lines.join("\n");
}

async function main() {
	const sdkVersion = extractSdkVersion();
	const tag = sdkVersionToMonorepoTag(sdkVersion);

	// biome-ignore lint/suspicious/noConsole: CLI script output
	console.log(`Pulumi SDK: ${sdkVersion} (tag: ${tag})`);

	const source = await fetchGoFile(tag, ENDPOINTS_PATH);
	const routes = parseEndpoints(source);
	// biome-ignore lint/suspicious/noConsole: CLI script output
	console.log(`Parsed ${routes.length} routes from api_endpoints.go`);

	const ts = generateTs(routes, sdkVersion);
	writeFileSync(OUT_FILE, ts);
	// biome-ignore lint/suspicious/noConsole: CLI script output
	console.log(`✓ Generated ${OUT_FILE}`);
}

if (import.meta.main) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
