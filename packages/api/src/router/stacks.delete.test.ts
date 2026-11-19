import { describe, expect, mock, test } from "bun:test";
import type { DeleteStackOptions } from "@procella/stacks";
import type { TRPCContext } from "../trpc.js";
import { stacksRouter } from "./stacks.js";

const TX = { tx: true } as never;

function mockContext(
	deleteStack: TRPCContext["stacks"]["deleteStack"],
	deleteEnvironment?: (...args: unknown[]) => Promise<void>,
): TRPCContext {
	return {
		caller: {
			tenantId: "tenant-1",
			orgSlug: "org-1",
			userId: "user-1",
			login: "admin",
			roles: ["admin"],
			principalType: "user",
		},
		resolveUserDisplayName: async () => null,
		db: {} as never,
		notifications: {} as never,
		stacks: { deleteStack } as never,
		audit: {} as never,
		updates: {} as never,
		webhooks: {} as never,
		esc: { deleteEnvironment } as never,
		github: null,
	};
}

/** deleteStack fake that runs the in-transaction hook for a stack managing `managedEnvironment`. */
function deleteStackRunningHook(managedEnvironment: string | null, deleted: string[]) {
	const managedEnvironmentId = managedEnvironment ? "env-1" : null;
	return mock(
		async (
			_t: string,
			_o: string,
			_p: string,
			stack: string,
			_force?: boolean,
			options?: DeleteStackOptions,
		) => {
			await options?.withinTransaction?.(TX, { managedEnvironment, managedEnvironmentId });
			deleted.push(stack);
		},
	);
}

describe("stacks.delete", () => {
	test("forwards force to the stack service", async () => {
		const deleteStack = mock(async () => {});
		const caller = stacksRouter.createCaller(mockContext(deleteStack));

		await caller.delete({ org: "org-1", project: "project-1", stack: "dev", force: true });

		expect(deleteStack).toHaveBeenCalledWith(
			"tenant-1",
			"org-1",
			"project-1",
			"dev",
			true,
			expect.any(Object),
		);
	});

	test("keeps deletion guarded when force is omitted", async () => {
		const deleteStack = mock(async () => {});
		const caller = stacksRouter.createCaller(mockContext(deleteStack));

		await caller.delete({ org: "org-1", project: "project-1", stack: "dev" });

		expect(deleteStack).toHaveBeenCalledWith(
			"tenant-1",
			"org-1",
			"project-1",
			"dev",
			undefined,
			expect.any(Object),
		);
	});

	test("deletes the managed ESC environment in the stack's deletion transaction", async () => {
		const deleted: string[] = [];
		const deleteEnvironment = mock(async () => {});
		const caller = stacksRouter.createCaller(
			mockContext(deleteStackRunningHook("project-1/dev", deleted), deleteEnvironment),
		);

		await caller.delete({ org: "org-1", project: "project-1", stack: "dev" });

		expect(deleted).toEqual(["dev"]);
		expect(deleteEnvironment).toHaveBeenCalledWith("tenant-1", "project-1", "dev", {
			tx: TX,
			expectedId: "env-1",
		});
	});

	test("a failed environment deletion aborts the stack deletion", async () => {
		const deleted: string[] = [];
		const deleteEnvironment = mock(async () => {
			throw new Error("db down");
		});
		const caller = stacksRouter.createCaller(
			mockContext(deleteStackRunningHook("project-1/dev", deleted), deleteEnvironment),
		);

		await expect(
			caller.delete({ org: "org-1", project: "project-1", stack: "dev" }),
		).rejects.toThrow();
		expect(deleted).toEqual([]);
	});

	test("unmanaged stacks do not touch ESC", async () => {
		const deleted: string[] = [];
		const deleteEnvironment = mock(async () => {});
		const caller = stacksRouter.createCaller(
			mockContext(deleteStackRunningHook(null, deleted), deleteEnvironment),
		);

		await caller.delete({ org: "org-1", project: "project-1", stack: "dev" });

		expect(deleted).toEqual(["dev"]);
		expect(deleteEnvironment).not.toHaveBeenCalled();
	});
});
