import { describe, expect, test } from "bun:test";
import {
	type Caller,
	formatStackFQN,
	hasAnyRole,
	hasRole,
	parseStackFQN,
	type StackFQN,
} from "./domain.js";

describe("@procella/types domain", () => {
	// ========================================================================
	// hasRole / hasAnyRole
	// ========================================================================

	describe("hasRole", () => {
		const adminCaller: Caller = {
			tenantId: "t-1",
			orgSlug: "org",
			userId: "u-1",
			login: "admin",
			roles: ["admin"],
			principalType: "user",
		};

		const viewerCaller: Caller = {
			tenantId: "t-1",
			orgSlug: "org",
			userId: "u-2",
			login: "viewer",
			roles: ["viewer"],
			principalType: "user",
		};

		test("returns true when caller has the role", () => {
			expect(hasRole(adminCaller, "admin")).toBe(true);
		});

		test("returns false when caller lacks the role", () => {
			expect(hasRole(viewerCaller, "admin")).toBe(false);
		});

		test("returns true for viewer checking viewer", () => {
			expect(hasRole(viewerCaller, "viewer")).toBe(true);
		});
	});

	describe("hasAnyRole", () => {
		const memberCaller: Caller = {
			tenantId: "t-1",
			orgSlug: "org",
			userId: "u-3",
			login: "member",
			roles: ["member"],
			principalType: "user",
		};

		test("returns true when any role matches", () => {
			expect(hasAnyRole(memberCaller, "admin", "member")).toBe(true);
		});

		test("returns false when no role matches", () => {
			expect(hasAnyRole(memberCaller, "admin")).toBe(false);
		});

		test("returns true for single matching role", () => {
			expect(hasAnyRole(memberCaller, "member")).toBe(true);
		});
	});

	// ========================================================================
	// StackFQN
	// ========================================================================

	describe("formatStackFQN", () => {
		test("formats org/project/stack", () => {
			const fqn: StackFQN = { org: "myorg", project: "myproj", stack: "dev" };
			expect(formatStackFQN(fqn)).toBe("myorg/myproj/dev");
		});

		test("handles special characters", () => {
			const fqn: StackFQN = { org: "org-1", project: "my_proj", stack: "stack.prod" };
			expect(formatStackFQN(fqn)).toBe("org-1/my_proj/stack.prod");
		});

		test("handles empty strings", () => {
			const fqn: StackFQN = { org: "", project: "", stack: "" };
			expect(formatStackFQN(fqn)).toBe("//");
		});
	});

	describe("parseStackFQN", () => {
		test("parses valid org/project/stack", () => {
			const parsed = parseStackFQN("myorg/myproj/dev");
			expect(parsed.org).toBe("myorg");
			expect(parsed.project).toBe("myproj");
			expect(parsed.stack).toBe("dev");
		});

		test("throws on too few parts", () => {
			expect(() => parseStackFQN("myorg/myproj")).toThrow("Invalid stack FQN");
		});

		test("throws on single part", () => {
			expect(() => parseStackFQN("myorg")).toThrow("Invalid stack FQN");
		});

		test("throws on too many parts", () => {
			expect(() => parseStackFQN("a/b/c/d")).toThrow("Invalid stack FQN");
		});

		test("throws on empty string", () => {
			expect(() => parseStackFQN("")).toThrow("Invalid stack FQN");
		});

		test("roundtrips with formatStackFQN", () => {
			const original = "myorg/myproj/staging";
			const formatted = formatStackFQN(parseStackFQN(original));
			expect(formatted).toBe(original);
		});
	});
});
