import { describe, expect, test } from "bun:test";
import type { AuthService } from "@procella/auth";
import type { StacksService } from "@procella/stacks";
import { UnauthorizedError } from "@procella/types";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { updateAuth } from "./auth.js";

function mockAuthService(): AuthService {
	return {
		authenticate: async () => {
			throw new UnauthorizedError("not used");
		},
		authenticateUpdateToken: async () => ({
			updateId: "upd-1",
			stackId: "stack-a-id",
		}),
		resolveUserDisplayName: async () => null,
	};
}

function mockStacksService(
	override?: Partial<{ projectName: string; stackName: string; tenantId: string }>,
): Pick<StacksService, "getStackById_systemOnly"> {
	return {
		getStackById_systemOnly: async (stackId: string) => ({
			id: stackId,
			projectId: "proj-1",
			tenantId: override?.tenantId ?? "tenant-a",
			orgName: override?.tenantId ?? "tenant-a",
			projectName: override?.projectName ?? "proj-a",
			stackName: override?.stackName ?? "stack-a",
			tags: {},
			activeUpdateId: null,
			lastUpdate: null,
			resourceCount: null,
			createdAt: new Date("2025-01-01T00:00:00Z"),
			updatedAt: new Date("2025-01-01T00:00:00Z"),
		}),
	};
}

describe("updateAuth lease binding", () => {
	test("returns 403 when lease token stack does not match URL project/stack names", async () => {
		const app = new Hono<Env>();
		app.use(
			"/stacks/:org/:project/:stack/update/:updateId/complete",
			updateAuth(
				mockAuthService(),
				async () => {},
				mockStacksService({ projectName: "proj-a", stackName: "stack-a" }),
			),
		);
		app.post("/stacks/:org/:project/:stack/update/:updateId/complete", (c) => c.body(null, 204));

		const res = await app.request(
			"/stacks/victim-org/victim-proj/victim-stack/update/upd-1/complete",
			{
				method: "POST",
				headers: { Authorization: "update-token update:upd-1:stack-a-id:secret" },
			},
		);

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			code: "lease_url_mismatch",
			message: "Lease token does not match URL stack",
		});
	});

	test("regression(procella-64t): OIDC mode where URL org slug differs from descope tenantId is accepted", async () => {
		const humanReadableOrgSlug = "procella-pr-151";
		const descopeTenantIdUuid = "T2xxxxxxxxxxxxxxxxxxxxxxxxx";
		const projectName = "replace-triggers";
		const stackName = "oidc-e2e";

		const app = new Hono<Env>();
		app.use(
			"/stacks/:org/:project/:stack/update/:updateId/complete",
			updateAuth(
				mockAuthService(),
				async () => {},
				mockStacksService({
					projectName,
					stackName,
					tenantId: descopeTenantIdUuid,
				}),
			),
		);
		app.post("/stacks/:org/:project/:stack/update/:updateId/complete", (c) => c.body(null, 204));

		const res = await app.request(
			`/stacks/${humanReadableOrgSlug}/${projectName}/${stackName}/update/upd-1/complete`,
			{
				method: "POST",
				headers: { Authorization: "update-token update:upd-1:stack-a-id:secret" },
			},
		);

		expect(res.status).toBe(204);
	});
});
