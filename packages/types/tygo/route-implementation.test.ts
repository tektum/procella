import { describe, expect, test } from "bun:test";
import { CompatibilityStatus, PULUMI_ROUTE_POLICY } from "../src/compatibility.js";
import { PulumiRoutes } from "../src/routes.gen.js";
import { bestMatchKind, readServerRouteInventory } from "./server-route-inventory.js";

// Pulumi uses the literal `update` lifecycle path after creating every update
// kind. These entries prove that exact partial route instead of accepting any
// structurally similar literal.
const DOCUMENTED_PARTIAL_ROUTES: Readonly<Record<string, string>> = {
	getUpdateStatus: "/api/stacks/:org/:project/:stack/update/:updateId",
	startUpdate: "/api/stacks/:org/:project/:stack/update/:updateId",
};

// Routes independently verified absent from both apps/server/src/routes/index.ts
// and cli.ts via exact method/path comparison. Regression guard: if any of
// these is ever reclassified core-implemented without a matching route
// actually being added, this test fails and names it.
const KNOWN_ABSENT_ROUTES = [
	"listOrganizationStacks",
	"createStack",
	"getStackLogs",
	"getLatestStackUpdate",
	"getStackUpdate",
	"getUpdateContentsFiles",
	"getUpdateContentsFilePath",
	"projectExists",
	"updateStackConfig",
	"postEngineEvent",
] as const;

describe("PULUMI_ROUTE_POLICY vs actual server route registration", () => {
	const serverRoutes = readServerRouteInventory(PulumiRoutes);

	test("the server inventory extraction found routes in both assemblers", () => {
		expect(serverRoutes.length).toBeGreaterThan(20);
	});

	for (const routeName of Object.keys(PulumiRoutes)) {
		test(`"${routeName}" core-implemented classification is backed by an actual server route`, () => {
			const classification = PULUMI_ROUTE_POLICY.find((entry) => entry.id === routeName);
			expect(classification, `${routeName} has no PULUMI_ROUTE_POLICY entry`).toBeDefined();
			if (classification?.status !== CompatibilityStatus.CoreImplemented) {
				// Only core-implemented claims must be backed by a real route match;
				// intentionally-unsupported/watching/opt-in routes are not exercised here.
				return;
			}

			const upstream = PulumiRoutes[routeName as keyof typeof PulumiRoutes];
			const matchKind = bestMatchKind(upstream, serverRoutes);
			const documentedPath = DOCUMENTED_PARTIAL_ROUTES[routeName];

			if (documentedPath) {
				expect(serverRoutes).toContainEqual({ method: upstream.method, path: documentedPath });
				expect(matchKind).toBe("partial");
				return;
			}

			expect(
				matchKind,
				`${routeName} is classified core-implemented but no server route (index.ts or cli.ts) structurally matches ${upstream.method} ${upstream.path}`,
			).toBe("full");
		});
	}

	test("known genuinely-absent routes are not misclassified as core-implemented", () => {
		for (const routeName of KNOWN_ABSENT_ROUTES) {
			const upstream = PulumiRoutes[routeName as keyof typeof PulumiRoutes];
			expect(
				bestMatchKind(upstream, serverRoutes),
				`${routeName} unexpectedly matched a server route; it may have been implemented and should be reclassified`,
			).toBeNull();

			const classification = PULUMI_ROUTE_POLICY.find((entry) => entry.id === routeName);
			expect(
				classification?.status,
				`${routeName} has no matching server route and must not be classified core-implemented`,
			).not.toBe(CompatibilityStatus.CoreImplemented);
		}
	});

	test("mutation guard: a route with zero server-inventory match can never satisfy the core-implemented check", () => {
		// Exercises the matcher directly (not the real manifest) to prove that if
		// a maintainer ever marks a genuinely-absent route core-implemented, the
		// per-route assertion above is structurally guaranteed to catch it.
		const neverRegistered = {
			method: "GET",
			path: "/api/stacks/:org/:project/:stack/some-never-registered-path",
		};
		expect(bestMatchKind(neverRegistered, serverRoutes)).toBeNull();
	});
});
