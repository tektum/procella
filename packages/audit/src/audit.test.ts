import { describe, expect, test } from "bun:test";
import {
	AuditAction,
	extractResourceId,
	extractResourceType,
	mapActionToType,
	mapRouteToAction,
	NoopAuditService,
} from "./index.js";

describe("@procella/audit", () => {
	test("mapRouteToAction maps known routes", () => {
		expect(mapRouteToAction("POST", "/api/stacks/org/proj/dev")).toBe(AuditAction.STACK_CREATE);
		expect(mapRouteToAction("DELETE", "/api/stacks/org/proj/dev")).toBe(AuditAction.STACK_DELETE);
		expect(mapRouteToAction("POST", "/api/stacks/org/proj/dev/rename")).toBe(
			AuditAction.STACK_RENAME,
		);
		expect(mapRouteToAction("PATCH", "/api/stacks/org/proj/dev/tags")).toBe(
			AuditAction.STACK_TAGS_UPDATE,
		);
		expect(mapRouteToAction("POST", "/api/stacks/org/proj/dev/update")).toBe(
			AuditAction.UPDATE_CREATE,
		);
		expect(mapRouteToAction("POST", "/api/stacks/org/proj/dev/preview")).toBe(
			AuditAction.UPDATE_CREATE,
		);
		expect(mapRouteToAction("POST", "/api/stacks/org/proj/dev/refresh")).toBe(
			AuditAction.UPDATE_CREATE,
		);
		expect(mapRouteToAction("POST", "/api/stacks/org/proj/dev/destroy")).toBe(
			AuditAction.UPDATE_CREATE,
		);
		expect(mapRouteToAction("POST", "/api/stacks/org/proj/dev/update/u1/complete")).toBe(
			AuditAction.UPDATE_COMPLETE,
		);
		expect(mapRouteToAction("POST", "/api/stacks/org/proj/dev/update/u1/cancel")).toBe(
			AuditAction.UPDATE_CANCEL,
		);
		expect(mapRouteToAction("POST", "/api/stacks/org/proj/dev/import")).toBe(
			AuditAction.STACK_IMPORT,
		);
		expect(mapRouteToAction("POST", "/api/orgs/org/tokens")).toBe(AuditAction.TOKEN_CREATE);
		expect(mapRouteToAction("DELETE", "/api/orgs/org/tokens/tok1")).toBe(AuditAction.TOKEN_REVOKE);
	});

	test("mapRouteToAction returns null for unknown routes", () => {
		expect(mapRouteToAction("GET", "/api/stacks/org/proj/dev")).toBeNull();
		expect(mapRouteToAction("POST", "/api/unknown/path")).toBeNull();
	});

	test("extractResourceId extracts stack and token identifiers", () => {
		expect(extractResourceId("/api/stacks/org/proj/dev")).toBe("org/proj/dev");
		expect(extractResourceId("/api/stacks/org/proj/dev/update/u1/cancel")).toBe("org/proj/dev");
		expect(extractResourceId("/api/orgs/org/tokens")).toBe("org");
		expect(extractResourceId("/api/orgs/org/tokens/tok1")).toBe("org/tok1");
	});

	test("action constants are strings", () => {
		for (const value of Object.values(AuditAction)) {
			expect(typeof value).toBe("string");
		}
	});

	test("mapActionToType maps destructive actions to warn", () => {
		expect(mapActionToType("stack.delete")).toBe("warn");
		expect(mapActionToType("token.revoke")).toBe("warn");
		expect(mapActionToType("update.cancel")).toBe("warn");
		expect(mapActionToType("stack.create")).toBe("info");
	});

	test("mapRouteToAction maps webhook routes", () => {
		expect(mapRouteToAction("POST", "/api/orgs/org/hooks")).toBe(AuditAction.WEBHOOK_CREATE);
		expect(mapRouteToAction("DELETE", "/api/orgs/org/hooks/h1")).toBe(AuditAction.WEBHOOK_DELETE);
	});

	test("extractResourceType identifies resource types", () => {
		expect(extractResourceType("/api/stacks/org/proj/dev")).toBe("stack");
		expect(extractResourceType("/api/stacks/org/proj/dev/update/u1")).toBe("update");
		expect(extractResourceType("/api/orgs/org/tokens")).toBe("token");
		expect(extractResourceType("/api/orgs/org/tokens/tok1")).toBe("token");
		expect(extractResourceType("/api/orgs/org/hooks")).toBe("webhook");
		expect(extractResourceType("/api/orgs/org/hooks/h1")).toBe("webhook");
		expect(extractResourceType("/api/unknown")).toBe("unknown");
	});

	test("extractResourceId falls back to path for unknown patterns", () => {
		expect(extractResourceId("/api/unknown/path")).toBe("/api/unknown/path");
	});

	test("mapActionToType returns info for non-destructive actions", () => {
		expect(mapActionToType("stack.update")).toBe("info");
		expect(mapActionToType("stack.import")).toBe("info");
		expect(mapActionToType("token.create")).toBe("info");
		expect(mapActionToType("webhook.create")).toBe("info");
		expect(mapActionToType("webhook.delete")).toBe("warn");
	});
});

describe("NoopAuditService", () => {
	test("retains logged entries and filters by action/tenant for query", async () => {
		const audit = new NoopAuditService();
		audit.log("tenant-a", {
			actorId: "user-1",
			actorType: "user",
			action: AuditAction.STACK_CREATE,
			resourceType: "stack",
			resourceId: "dev-org/security/xff-1",
			ipAddress: "127.0.0.1",
		});
		audit.log("tenant-a", {
			actorId: "user-1",
			actorType: "user",
			action: AuditAction.STACK_DELETE,
			resourceType: "stack",
			resourceId: "dev-org/security/other",
			ipAddress: "127.0.0.1",
		});
		audit.log("tenant-b", {
			actorId: "user-2",
			actorType: "user",
			action: AuditAction.STACK_CREATE,
			resourceType: "stack",
			resourceId: "other-org/security/xff-1",
			ipAddress: "10.0.0.1",
		});

		const result = await audit.query("tenant-a", {
			action: AuditAction.STACK_CREATE,
			pageSize: 20,
		});
		expect(result.total).toBe(1);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.resourceId).toBe("dev-org/security/xff-1");
		expect(result.entries[0]?.ipAddress).toBe("127.0.0.1");
		expect(result.entries[0]?.id).toBeTruthy();
		expect(result.entries[0]?.createdAt).toBeInstanceOf(Date);
	});

	test("export returns filtered entries without pagination", async () => {
		const audit = new NoopAuditService();
		for (let i = 0; i < 3; i++) {
			audit.log("tenant-a", {
				actorId: "user-1",
				actorType: "user",
				action: AuditAction.STACK_CREATE,
				resourceType: "stack",
				resourceId: `stack-${i}`,
			});
		}

		const exported = await audit.export("tenant-a", { action: AuditAction.STACK_CREATE });
		expect(exported).toHaveLength(3);
	});
});
