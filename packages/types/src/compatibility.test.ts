import { describe, expect, test } from "bun:test";
import {
	CompatibilityStatus,
	LOCAL_EXTENSION_STATUS,
	PULUMI_CAPABILITY_POLICY,
	PULUMI_ROUTE_POLICY,
	validateCompatibilityManifest,
} from "./compatibility.js";

const REAL_CAPABILITIES = PULUMI_CAPABILITY_POLICY.map((entry) => entry.id);
const REAL_ROUTES = PULUMI_ROUTE_POLICY.map((entry) => entry.id);

describe("validateCompatibilityManifest", () => {
	test("passes for the real manifest against its own classified ids", () => {
		const errors = validateCompatibilityManifest({
			capabilities: REAL_CAPABILITIES,
			routes: REAL_ROUTES,
		});
		expect(errors).toEqual([]);
	});

	test("rejects an unclassified (synthetic drift) capability by name", () => {
		const errors = validateCompatibilityManifest({
			capabilities: [...REAL_CAPABILITIES, "totally-new-upstream-capability"],
			routes: REAL_ROUTES,
		});
		expect(errors).toContain(
			'missing capability classification: "totally-new-upstream-capability" is generated upstream but has no policy entry',
		);
	});

	test("rejects an unclassified (synthetic drift) route by name", () => {
		const errors = validateCompatibilityManifest({
			capabilities: REAL_CAPABILITIES,
			routes: [...REAL_ROUTES, "totallyNewUpstreamRoute"],
		});
		expect(errors).toContain(
			'missing route classification: "totallyNewUpstreamRoute" is generated upstream but has no policy entry',
		);
	});

	test("rejects a manifest entry for a capability that no longer exists upstream", () => {
		const errors = validateCompatibilityManifest({
			capabilities: REAL_CAPABILITIES.filter((id) => id !== "begin-update"),
			routes: REAL_ROUTES,
		});
		expect(errors).toContain(
			'extra capability classification: "begin-update" has a policy entry but is not present in the generated upstream inventory',
		);
	});

	test("rejects duplicate capability classifications", () => {
		const errors = validateCompatibilityManifest(
			{ capabilities: REAL_CAPABILITIES, routes: REAL_ROUTES },
			{
				capabilityPolicy: [
					...PULUMI_CAPABILITY_POLICY,
					{
						id: "batch-encrypt",
						status: CompatibilityStatus.CoreImplemented,
						note: "duplicate injected by test",
					},
				],
				routePolicy: PULUMI_ROUTE_POLICY,
				localCapabilityExtensions: [],
			},
		);
		expect(errors).toContain(
			'duplicate capability classification: "batch-encrypt" appears 2 times',
		);
	});

	test("rejects duplicate route classifications", () => {
		const errors = validateCompatibilityManifest(
			{ capabilities: REAL_CAPABILITIES, routes: REAL_ROUTES },
			{
				capabilityPolicy: PULUMI_CAPABILITY_POLICY,
				routePolicy: [
					...PULUMI_ROUTE_POLICY,
					{
						id: "getCapabilities",
						status: CompatibilityStatus.CoreImplemented,
						note: "duplicate injected by test",
					},
				],
				localCapabilityExtensions: [],
			},
		);
		expect(errors).toContain('duplicate route classification: "getCapabilities" appears 2 times');
	});

	test("rejects a local extension that collides with an upstream capability value", () => {
		const errors = validateCompatibilityManifest(
			{ capabilities: REAL_CAPABILITIES, routes: REAL_ROUTES },
			{
				capabilityPolicy: PULUMI_CAPABILITY_POLICY,
				routePolicy: PULUMI_ROUTE_POLICY,
				localCapabilityExtensions: [
					{ id: "batch-encrypt", status: LOCAL_EXTENSION_STATUS, note: "should be rejected" },
				],
			},
		);
		expect(errors).toContain(
			'local capability extension "batch-encrypt" collides with an upstream APICapability value; it must be classified in PULUMI_CAPABILITY_POLICY instead',
		);
	});

	test("rejects a local extension with a non-local-extension status", () => {
		const errors = validateCompatibilityManifest(
			{ capabilities: REAL_CAPABILITIES, routes: REAL_ROUTES },
			{
				capabilityPolicy: PULUMI_CAPABILITY_POLICY,
				routePolicy: PULUMI_ROUTE_POLICY,
				localCapabilityExtensions: [
					{
						id: "journaling-v1",
						status: CompatibilityStatus.CoreImplemented,
						note: "wrong status",
					},
				],
			},
		);
		expect(errors).toContain(
			`local capability extension "journaling-v1" must use status "${LOCAL_EXTENSION_STATUS}", got "${CompatibilityStatus.CoreImplemented}"`,
		);
	});

	test("rejects an invalid classification status", () => {
		const errors = validateCompatibilityManifest(
			{ capabilities: REAL_CAPABILITIES, routes: REAL_ROUTES },
			{
				capabilityPolicy: [
					...PULUMI_CAPABILITY_POLICY.filter((entry) => entry.id !== "begin-update"),
					// Deliberately malformed status to exercise runtime validation; not a real CompatibilityStatus.
					{
						id: "begin-update",
						status: "not-a-real-status" as unknown as CompatibilityStatus,
						note: "malformed",
					},
				],
				routePolicy: PULUMI_ROUTE_POLICY,
				localCapabilityExtensions: [],
			},
		);
		expect(errors).toContain(
			'invalid capability classification status "not-a-real-status" for "begin-update"',
		);
	});

	test("journaling-v1 is only classified as a local extension, never in the upstream capability policy", () => {
		expect(REAL_CAPABILITIES).not.toContain("journaling-v1");
	});
});
