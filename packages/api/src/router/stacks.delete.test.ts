import { describe, expect, mock, test } from "bun:test";
import type { TRPCContext } from "../trpc.js";
import { stacksRouter } from "./stacks.js";

function mockContext(
	deleteStack: TRPCContext["stacks"]["deleteStack"],
	options: {
		managedEnvironment?: string;
		deleteEnvironment?: (...args: unknown[]) => Promise<void>;
	} = {},
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
		stacks: {
			deleteStack,
			getStack: async () => ({ managedEnvironment: options.managedEnvironment ?? null }),
		} as never,
		audit: {} as never,
		updates: {} as never,
		webhooks: {} as never,
		esc: { deleteEnvironment: options.deleteEnvironment } as never,
		github: null,
	};
}

describe("stacks.delete", () => {
	test("forwards force to the stack service", async () => {
		const deleteStack = mock(async () => {});
		const caller = stacksRouter.createCaller(mockContext(deleteStack));

		await caller.delete({ org: "org-1", project: "project-1", stack: "dev", force: true });

		expect(deleteStack).toHaveBeenCalledWith("tenant-1", "org-1", "project-1", "dev", true);
	});

	test("keeps deletion guarded when force is omitted", async () => {
		const deleteStack = mock(async () => {});
		const caller = stacksRouter.createCaller(mockContext(deleteStack));

		await caller.delete({ org: "org-1", project: "project-1", stack: "dev" });

		expect(deleteStack).toHaveBeenCalledWith("tenant-1", "org-1", "project-1", "dev", undefined);
	});

	test("deletes the managed ESC environment after the stack", async () => {
		const order: string[] = [];
		const deleteStack = mock(async () => {
			order.push("stack");
		});
		const deleteEnvironment = mock(async () => {
			order.push("env");
		});
		const caller = stacksRouter.createCaller(
			mockContext(deleteStack, { managedEnvironment: "project-1/dev", deleteEnvironment }),
		);

		await caller.delete({ org: "org-1", project: "project-1", stack: "dev" });

		expect(order).toEqual(["stack", "env"]);
		expect(deleteEnvironment).toHaveBeenCalledWith("tenant-1", "project-1", "dev");
	});

	test("does not fail when the managed environment cannot be deleted", async () => {
		const deleteEnvironment = mock(async () => {
			throw new Error("db down");
		});
		const caller = stacksRouter.createCaller(
			mockContext(
				mock(async () => {}),
				{ managedEnvironment: "project-1/dev", deleteEnvironment },
			),
		);

		await expect(
			caller.delete({ org: "org-1", project: "project-1", stack: "dev" }),
		).resolves.toBeUndefined();
	});
});
