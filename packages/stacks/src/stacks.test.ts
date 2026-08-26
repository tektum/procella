import { describe, expect, test } from "bun:test";
import { InvalidNameError } from "@procella/types";
import type { StackInfo, StacksService } from "./index.js";
import { buildStackTags, mergeTags, pgErrorCode, validateName } from "./index.js";

describe("@procella/stacks", () => {
	// ========================================================================
	// buildStackTags — Pulumi standard tags
	// ========================================================================

	describe("buildStackTags", () => {
		test("sets pulumi:project and pulumi:stack", () => {
			const tags = buildStackTags("my-proj", "production");
			expect(tags).toEqual({
				"pulumi:project": "my-proj",
				"pulumi:stack": "production",
			});
		});

		test("merges user tags after standard tags", () => {
			const tags = buildStackTags("proj", "stk", {
				env: "prod",
				team: "infra",
			});
			expect(tags).toEqual({
				"pulumi:project": "proj",
				"pulumi:stack": "stk",
				env: "prod",
				team: "infra",
			});
		});

		test("user tags can override standard tags", () => {
			const tags = buildStackTags("proj", "stk", {
				"pulumi:project": "custom-name",
			});
			expect(tags["pulumi:project"]).toBe("custom-name");
		});
	});

	// ========================================================================
	// mergeTags
	// ========================================================================

	describe("mergeTags", () => {
		test("preserves existing tags and adds new ones", () => {
			const existing = { a: "1", b: "2" };
			const incoming = { c: "3", d: "4" };
			const result = mergeTags(existing, incoming);
			expect(result).toEqual({ a: "1", b: "2", c: "3", d: "4" });
		});

		test("incoming tags override existing tags", () => {
			const existing = { a: "1", b: "2" };
			const incoming = { b: "override", c: "3" };
			const result = mergeTags(existing, incoming);
			expect(result).toEqual({ a: "1", b: "override", c: "3" });
		});

		test("does not mutate inputs", () => {
			const existing = { a: "1" };
			const incoming = { b: "2" };
			mergeTags(existing, incoming);
			expect(existing).toEqual({ a: "1" });
			expect(incoming).toEqual({ b: "2" });
		});
	});

	// ========================================================================
	// pgErrorCode — PG SQLSTATE extraction from wrapped errors
	// ========================================================================

	describe("pgErrorCode", () => {
		test("extracts code from direct PostgresError", () => {
			const err = Object.assign(new Error("unique_violation"), { code: "23505" });
			expect(pgErrorCode(err)).toBe("23505");
		});

		test("extracts code from DrizzleQueryError wrapping", () => {
			const pgErr = Object.assign(new Error("unique_violation"), { code: "23505" });
			const drizzleErr = new Error("Failed query: INSERT INTO...");
			drizzleErr.cause = pgErr;
			expect(pgErrorCode(drizzleErr)).toBe("23505");
		});

		test("extracts code from double-wrapped cause chain", () => {
			const pgErr = Object.assign(new Error("unique_violation"), { code: "23505" });
			const mid = new Error("query failed");
			mid.cause = pgErr;
			const outer = new Error("transaction failed");
			outer.cause = mid;
			expect(pgErrorCode(outer)).toBe("23505");
		});

		test("extracts code from AggregateError.errors", () => {
			const pgErr = Object.assign(new Error("unique_violation"), { code: "23505" });
			const agg = new AggregateError([pgErr], "multiple errors");
			expect(pgErrorCode(agg)).toBe("23505");
		});

		test("extracts code from non-Error object with cause", () => {
			const pgErr = { code: "23505", message: "unique_violation" };
			const wrapper = { cause: pgErr, message: "wrapped" };
			expect(pgErrorCode(wrapper)).toBe("23505");
		});

		test("returns undefined for unrelated errors", () => {
			expect(pgErrorCode(new Error("timeout"))).toBeUndefined();
			expect(pgErrorCode(null)).toBeUndefined();
			expect(pgErrorCode(undefined)).toBeUndefined();
		});

		test("ignores non-SQLSTATE code strings", () => {
			const err = Object.assign(new Error("fail"), { code: "ERR_CONNECTION_CLOSED" });
			expect(pgErrorCode(err)).toBeUndefined();
		});

		test("extracts alphanumeric SQLSTATE codes", () => {
			const err = Object.assign(new Error("undefined_table"), { code: "42P01" });
			expect(pgErrorCode(err)).toBe("42P01");
		});

		test("extracts SQLSTATE from Bun.sql errno (numeric)", () => {
			const pgErr = Object.assign(new Error("unique_violation"), {
				code: "ERR_POSTGRES_SERVER_ERROR",
				errno: 23505,
			});
			expect(pgErrorCode(pgErr)).toBe("23505");
		});

		test("extracts SQLSTATE from Bun.sql errno via DrizzleQueryError cause", () => {
			const pgErr = Object.assign(new Error("unique_violation"), {
				code: "ERR_POSTGRES_SERVER_ERROR",
				errno: 23505,
			});
			const drizzleErr = new Error("Failed query: INSERT INTO...");
			drizzleErr.cause = pgErr;
			expect(pgErrorCode(drizzleErr)).toBe("23505");
		});
	});

	describe("validateName (M1)", () => {
		test("accepts lowercase alphanumeric", () => {
			expect(() => validateName("mystack", "stack")).not.toThrow();
		});

		test("accepts dots, dashes, underscores", () => {
			expect(() => validateName("my-stack_v1.0", "stack")).not.toThrow();
		});

		test("accepts uppercase letters", () => {
			expect(() => validateName("MyProject", "project")).not.toThrow();
		});

		test("accepts single character", () => {
			expect(() => validateName("a", "org")).not.toThrow();
		});

		test("accepts max-length name (64 chars)", () => {
			expect(() => validateName("a".repeat(64), "stack")).not.toThrow();
		});

		test("rejects name with slash", () => {
			expect(() => validateName("org/proj", "org")).toThrow(InvalidNameError);
		});

		test("rejects name with spaces", () => {
			expect(() => validateName("my stack", "stack")).toThrow(InvalidNameError);
		});

		test("rejects name with control chars", () => {
			expect(() => validateName("stack\x00name", "stack")).toThrow(InvalidNameError);
		});

		test("rejects unicode characters", () => {
			expect(() => validateName("стек", "stack")).toThrow(InvalidNameError);
		});

		test("rejects empty string", () => {
			expect(() => validateName("", "stack")).toThrow(InvalidNameError);
		});

		test("rejects name exceeding 64 characters", () => {
			expect(() => validateName("a".repeat(65), "stack")).toThrow(InvalidNameError);
		});

		test("rejects name with @ symbol", () => {
			expect(() => validateName("user@org", "org")).toThrow(InvalidNameError);
		});

		test("error message includes kind", () => {
			try {
				validateName("bad/name", "project");
				throw new Error("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(InvalidNameError);
				expect((e as InvalidNameError).message).toContain("project");
			}
		});

		test("error has statusCode 400", () => {
			try {
				validateName("", "stack");
				throw new Error("should have thrown");
			} catch (e) {
				expect((e as InvalidNameError).statusCode).toBe(400);
			}
		});
	});

	describe("StacksService.getStackByNames_systemOnly (M6)", () => {
		test("interface exposes system-only variant", () => {
			const mockInfo: StackInfo = {
				id: "id",
				projectId: "pid",
				tenantId: "tid",
				orgName: "tid",
				projectName: "p",
				stackName: "s",
				tags: {},
				activeUpdateId: null,
				lastUpdate: null,
				resourceCount: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			};

			const mock: StacksService = {
				createStack: async () => mockInfo,
				getStack: async () => mockInfo,
				listStacks: async () => [mockInfo],
				deleteStack: async () => {},
				renameStack: async () => {},
				updateStackTags: async () => {},
				replaceStackTags: async () => {},
				getStackByFQN: async () => mockInfo,
				getStackByNames_systemOnly: async () => mockInfo,
				getStackById_systemOnly: async () => mockInfo,
			};

			expect(typeof mock.getStackByNames_systemOnly).toBe("function");
			expect(typeof mock.getStackById_systemOnly).toBe("function");
		});
	});
});
