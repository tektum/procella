// E2E — Health, capabilities, and CLI version endpoints (public, no auth).

import { describe, expect, test } from "bun:test";
import { BACKEND_URL } from "./helpers.js";

describe("health and capabilities", () => {
	test("GET /healthz returns 200 with status ok", async () => {
		const res = await fetch(`${BACKEND_URL}/healthz`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "ok" });
	});

	test("GET /api/capabilities returns the exact expected wire shape", async () => {
		const res = await fetch(`${BACKEND_URL}/api/capabilities`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({
			capabilities: [
				{ capability: "batch-encrypt" },
				{ capability: "deployment-schema-version", version: 1, configuration: { version: 3 } },
				{ capability: "journaling-v1", version: 1 },
			],
		});
	});

	test("GET /api/cli/version returns version info", async () => {
		const res = await fetch(`${BACKEND_URL}/api/cli/version`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("latestVersion");
		expect(body).toHaveProperty("oldestWithoutWarning");
	});
});
