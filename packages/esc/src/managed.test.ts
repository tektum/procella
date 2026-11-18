import { describe, expect, mock, test } from "bun:test";
import { NotFoundError } from "@procella/types";
import { deleteManagedEnvironment, parseManagedEnvironmentName } from "./managed.js";

describe("parseManagedEnvironmentName", () => {
	test("splits <project>/<env>", () => {
		expect(parseManagedEnvironmentName("app/dev")).toEqual({ projectName: "app", envName: "dev" });
	});

	test.each(["", "app", "/dev", "app/", "a/b/c"])("rejects %p", (name) => {
		expect(parseManagedEnvironmentName(name)).toBeNull();
	});
});

describe("deleteManagedEnvironment", () => {
	test("deletes the named environment", async () => {
		const deleteEnvironment = mock(async () => {});
		await deleteManagedEnvironment({ deleteEnvironment }, "t-1", "app/dev");
		expect(deleteEnvironment).toHaveBeenCalledWith("t-1", "app", "dev");
	});

	test("treats a missing environment as already deleted", async () => {
		const deleteEnvironment = mock(async () => {
			throw new NotFoundError("Environment", "app/dev");
		});
		await expect(
			deleteManagedEnvironment({ deleteEnvironment }, "t-1", "app/dev"),
		).resolves.toBeUndefined();
	});

	test("propagates other errors and skips malformed names", async () => {
		const failing = mock(async () => {
			throw new Error("db down");
		});
		await expect(
			deleteManagedEnvironment({ deleteEnvironment: failing }, "t-1", "app/dev"),
		).rejects.toThrow("db down");
		const untouched = mock(async () => {});
		await deleteManagedEnvironment({ deleteEnvironment: untouched }, "t-1", "malformed");
		expect(untouched).not.toHaveBeenCalled();
	});
});
