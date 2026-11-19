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
	const owned = { managedEnvironment: "app/dev", managedEnvironmentId: "env-1" };

	test("deletes the owned environment by ID, passing the transaction through", async () => {
		const deleteEnvironment = mock(async () => {});
		const tx = { tx: true } as never;
		await deleteManagedEnvironment({ deleteEnvironment }, "t-1", owned, { tx });
		expect(deleteEnvironment).toHaveBeenCalledWith("t-1", "app", "dev", {
			tx,
			expectedId: "env-1",
		});
	});

	test("treats a missing or replaced environment as already deleted", async () => {
		const deleteEnvironment = mock(async () => {
			throw new NotFoundError("Environment", "app/dev");
		});
		await expect(
			deleteManagedEnvironment({ deleteEnvironment }, "t-1", owned),
		).resolves.toBeUndefined();
	});

	test("propagates other errors", async () => {
		const deleteEnvironment = mock(async () => {
			throw new Error("db down");
		});
		await expect(deleteManagedEnvironment({ deleteEnvironment }, "t-1", owned)).rejects.toThrow(
			"db down",
		);
	});

	test.each([
		[{ managedEnvironment: null, managedEnvironmentId: null }],
		[{ managedEnvironment: "app/dev", managedEnvironmentId: null }],
		[{ managedEnvironment: "malformed", managedEnvironmentId: "env-1" }],
	])("deletes nothing without an owned, well-formed environment: %p", async (stack) => {
		const deleteEnvironment = mock(async () => {});
		await deleteManagedEnvironment({ deleteEnvironment }, "t-1", stack);
		expect(deleteEnvironment).not.toHaveBeenCalled();
	});
});
