import { afterEach, describe, expect, test } from "bun:test";
import { fetchGoFile } from "./generate-routes.js";

describe("fetchGoFile", () => {
	const originalFetch = global.fetch;
	// Deliberately not a real pinned SDK tag: fetchGoFile only needs a tag
	// string to build a URL, and the test must not encode the go.mod version.
	const FAKE_TAG = "sdk/v0.0.0-fetchGoFile-test";

	afterEach(() => {
		global.fetch = originalFetch;
	});

	test("throws when the pinned tag request fails, without any master-branch fallback request", async () => {
		const requestedUrls: string[] = [];
		global.fetch = (async (input: string | URL) => {
			requestedUrls.push(String(input));
			return { ok: false, status: 404, statusText: "Not Found" } as Response;
		}) as typeof fetch;

		await expect(
			fetchGoFile(FAKE_TAG, "pkg/backend/httpstate/client/api_endpoints.go"),
		).rejects.toThrow(/Refusing to fall back to the master branch/);

		expect(requestedUrls).toEqual([
			`https://raw.githubusercontent.com/pulumi/pulumi/${FAKE_TAG}/pkg/backend/httpstate/client/api_endpoints.go`,
		]);
		expect(requestedUrls.some((url) => url.includes("/master/"))).toBeFalse();
	});

	test("returns the file body when the pinned tag request succeeds", async () => {
		global.fetch = (async () =>
			({ ok: true, status: 200, text: async () => "package client" }) as Response) as typeof fetch;

		const body = await fetchGoFile(FAKE_TAG, "pkg/backend/httpstate/client/api_endpoints.go");
		expect(body).toBe("package client");
	});
});
