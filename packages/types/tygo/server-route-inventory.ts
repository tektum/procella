// Extracts the exact set of HTTP method+path routes registered by the
// Pulumi-CLI-facing Hono app assemblers (apps/server/src/routes/index.ts and
// apps/server/src/routes/cli.ts), and compares them structurally against
// upstream PulumiRoutes entries. Read-only: never edits apps/server.
//
// Used by route-implementation.test.ts to prove PULUMI_ROUTE_POLICY's
// core-implemented claims are backed by an actual registered server route,
// not merely by being present in the exhaustive classification list.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SERVER_ROUTE_FILES = [
	resolve(import.meta.dir, "../../../apps/server/src/routes/index.ts"),
	resolve(import.meta.dir, "../../../apps/server/src/routes/cli.ts"),
];

export interface ServerRoute {
	readonly method: string;
	readonly path: string;
}

const LITERAL_ROUTE_REGEX = /\b(app|api)\.(get|post|put|patch|delete|head)\(\s*\n?\s*"([^"]+)"/g;
const ALIAS_ROUTE_REGEX = /\b(app|api)\.(get|post|put|patch|delete|head)\(\s*\n?\s*R\.(\w+)\.path/g;

/** Parses one server route-assembler file's Hono registrations into method+absolute-path pairs. */
export function parseServerRoutes(
	source: string,
	pulumiRoutes: Record<string, { method: string; path: string }>,
): ServerRoute[] {
	const routes: ServerRoute[] = [];

	for (const match of source.matchAll(LITERAL_ROUTE_REGEX)) {
		const [, receiver, method, path] = match;
		routes.push({ method: method.toUpperCase(), path: receiver === "api" ? `/api${path}` : path });
	}

	for (const match of source.matchAll(ALIAS_ROUTE_REGEX)) {
		const [, , method, routeName] = match;
		const upstream = pulumiRoutes[routeName];
		if (upstream) {
			routes.push({ method: method.toUpperCase(), path: upstream.path });
		}
	}

	return routes;
}

/** Reads and parses every server route-assembler file the manifest is checked against. */
export function readServerRouteInventory(
	pulumiRoutes: Record<string, { method: string; path: string }>,
): ServerRoute[] {
	return SERVER_ROUTE_FILES.flatMap((file) =>
		parseServerRoutes(readFileSync(file, "utf8"), pulumiRoutes),
	);
}

function segments(path: string): string[] {
	return path.split("/").filter(Boolean);
}

function isParamSegment(segment: string): boolean {
	return segment.startsWith(":");
}

/**
 * Structural match between an upstream PulumiRoutes entry (method + path with
 * named params) and one registered server route. "full" means the server
 * route accepts every concrete value the CLI could send for the upstream
 * route's params (the server segment is itself a param everywhere upstream
 * declares one). "partial" means the server route only accepts one specific
 * literal value where upstream declares a param (e.g. a {updateKind} route
 * hardcoded to the literal "update"). `null` means no structural relationship.
 */
export function matchRoute(
	upstream: { method: string; path: string },
	server: ServerRoute,
): "full" | "partial" | null {
	if (upstream.method.toUpperCase() !== server.method.toUpperCase()) return null;
	const upstreamSegments = segments(upstream.path);
	const serverSegments = segments(server.path);
	if (upstreamSegments.length !== serverSegments.length) return null;

	let partial = false;
	for (let i = 0; i < upstreamSegments.length; i++) {
		const upstreamSegment = upstreamSegments[i];
		const serverSegment = serverSegments[i];
		if (isParamSegment(serverSegment)) continue;
		if (isParamSegment(upstreamSegment)) {
			partial = true;
			continue;
		}
		if (upstreamSegment !== serverSegment) return null;
	}
	return partial ? "partial" : "full";
}

/** Best (highest-confidence) match kind for an upstream route against the full server inventory. */
export function bestMatchKind(
	upstream: { method: string; path: string },
	serverRoutes: readonly ServerRoute[],
): "full" | "partial" | null {
	let best: "full" | "partial" | null = null;
	for (const server of serverRoutes) {
		const kind = matchRoute(upstream, server);
		if (kind === "full") return "full";
		if (kind === "partial") best = "partial";
	}
	return best;
}
