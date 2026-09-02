import { describe, expect, test } from "bun:test";
import { tenantFromClaims } from "./claims";

describe("tenantFromClaims", () => {
	test("returns empty string for null/undefined claims", () => {
		expect(tenantFromClaims(null)).toBe("");
		expect(tenantFromClaims(undefined)).toBe("");
	});

	test("prefers the dct claim when present", () => {
		expect(tenantFromClaims({ dct: "tenant-1", tenants: { "tenant-2": {} } })).toBe("tenant-1");
	});

	test("falls back to a single tenants key when dct is absent", () => {
		expect(tenantFromClaims({ tenants: { "only-tenant": { roles: ["admin"] } } })).toBe(
			"only-tenant",
		);
	});

	test("returns empty string when multiple tenants and no dct (non-deterministic)", () => {
		expect(tenantFromClaims({ tenants: { a: {}, b: {} } })).toBe("");
	});

	test("ignores empty or non-string dct", () => {
		expect(tenantFromClaims({ dct: "" })).toBe("");
		expect(tenantFromClaims({ dct: 42 })).toBe("");
	});

	test("returns empty string when tenants is not an object", () => {
		expect(tenantFromClaims({ tenants: "nope" })).toBe("");
	});
});
