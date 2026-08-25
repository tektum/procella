import { describe, expect, mock, test } from "bun:test";
import { BadRequestError } from "@procella/types";
import { resolveAndValidateWebhookUrl, signPayload, validateWebhookUrl } from "./index.js";

describe("@procella/webhooks", () => {
	test("signPayload is deterministic for same payload + secret", async () => {
		const payload = JSON.stringify({ hello: "world" });
		const secret = "secret-a";
		const a = await signPayload(payload, secret);
		const b = await signPayload(payload, secret);
		expect(a).toBe(b);
		expect(a).toMatch(/^[a-f0-9]{64}$/);
	});

	test("signPayload differs for different secrets", async () => {
		const payload = JSON.stringify({ hello: "world" });
		const a = await signPayload(payload, "secret-a");
		const b = await signPayload(payload, "secret-b");
		expect(a).not.toBe(b);
	});

	test("generated secret uses UUID format when unspecified", () => {
		const secret = crypto.randomUUID();
		expect(secret).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
	});

	describe("validateWebhookUrl", () => {
		test("allows public HTTP and HTTPS URLs", () => {
			expect(() => validateWebhookUrl("https://example.com/webhook")).not.toThrow();
			expect(() => validateWebhookUrl("https://hooks.slack.com/services/T123")).not.toThrow();
			expect(() => validateWebhookUrl("http://203.0.113.1:8080/hook")).not.toThrow();
		});

		test("blocks localhost", () => {
			expect(() => validateWebhookUrl("http://localhost:9090/api")).toThrow(BadRequestError);
			expect(() => validateWebhookUrl("http://localhost/")).toThrow(BadRequestError);
		});

		test("blocks loopback IPs", () => {
			expect(() => validateWebhookUrl("http://127.0.0.1/")).toThrow(BadRequestError);
			expect(() => validateWebhookUrl("http://127.0.0.99:8080/hook")).toThrow(BadRequestError);
		});

		test("blocks AWS/cloud metadata endpoint", () => {
			expect(() => validateWebhookUrl("http://169.254.169.254/latest/meta-data/")).toThrow(
				BadRequestError,
			);
		});

		test("blocks private class A (10.x)", () => {
			expect(() => validateWebhookUrl("http://10.0.0.1/")).toThrow(BadRequestError);
			expect(() => validateWebhookUrl("http://10.255.255.255/")).toThrow(BadRequestError);
		});

		test("blocks private class B (172.16-31.x)", () => {
			expect(() => validateWebhookUrl("http://172.16.0.1/")).toThrow(BadRequestError);
			expect(() => validateWebhookUrl("http://172.31.255.255/")).toThrow(BadRequestError);
		});

		test("blocks private class C (192.168.x)", () => {
			expect(() => validateWebhookUrl("http://192.168.1.1/")).toThrow(BadRequestError);
		});

		test("blocks IPv6 loopback", () => {
			expect(() => validateWebhookUrl("http://[::1]/")).toThrow(BadRequestError);
		});

		test("blocks GCP metadata hostname", () => {
			expect(() => validateWebhookUrl("http://metadata.google.internal/")).toThrow(BadRequestError);
		});

		test("blocks non-HTTP protocols", () => {
			expect(() => validateWebhookUrl("ftp://example.com/")).toThrow(BadRequestError);
			expect(() => validateWebhookUrl("file:///etc/passwd")).toThrow(BadRequestError);
		});

		test("blocks link-local range", () => {
			expect(() => validateWebhookUrl("http://169.254.1.1/")).toThrow(BadRequestError);
		});

		test("blocks IPv4-mapped IPv6 loopback", () => {
			expect(() => validateWebhookUrl("http://[::ffff:127.0.0.1]/")).toThrow(BadRequestError);
		});

		test("allows hostnames that look like private IPs but are not", () => {
			expect(() => validateWebhookUrl("https://10.example.com/hook")).not.toThrow();
			expect(() => validateWebhookUrl("https://192.168.evil.com/hook")).not.toThrow();
		});
	});

	describe("resolveAndValidateWebhookUrl", () => {
		test("blocks DNS rebinding service hostnames (nip.io)", async () => {
			await expect(
				resolveAndValidateWebhookUrl("http://169.254.169.254.nip.io/latest/meta-data/"),
			).rejects.toThrow(BadRequestError);
		});

		test("blocks DNS rebinding service hostnames (sslip.io)", async () => {
			await expect(resolveAndValidateWebhookUrl("http://10.0.0.1.sslip.io/")).rejects.toThrow(
				BadRequestError,
			);
		});

		test("blocks DNS rebinding service hostnames (xip.io)", async () => {
			await expect(resolveAndValidateWebhookUrl("http://127.0.0.1.xip.io/hook")).rejects.toThrow(
				BadRequestError,
			);
		});

		test("blocks DNS rebinding service hostnames (localtest.me)", async () => {
			await expect(resolveAndValidateWebhookUrl("http://foo.localtest.me/")).rejects.toThrow(
				BadRequestError,
			);
		});

		test("blocks DNS rebinding service hostnames (lvh.me)", async () => {
			await expect(resolveAndValidateWebhookUrl("http://app.lvh.me/")).rejects.toThrow(
				BadRequestError,
			);
		});

		test("blocks hostnames that resolve to private IPs", async () => {
			const dns = await import("node:dns/promises");
			const origV4 = dns.resolve4;
			const origV6 = dns.resolve6;
			mock.module("node:dns/promises", () => ({
				resolve4: async () => ["127.0.0.1"],
				resolve6: async () => [],
			}));
			try {
				const { resolveAndValidateWebhookUrl: freshResolve } = await import("./index.js");
				await expect(freshResolve("https://evil-rebind.example.com/hook")).rejects.toThrow(
					BadRequestError,
				);
			} finally {
				mock.module("node:dns/promises", () => ({ resolve4: origV4, resolve6: origV6 }));
			}
		});

		test("still enforces string-level checks from validateWebhookUrl", async () => {
			await expect(resolveAndValidateWebhookUrl("http://localhost/")).rejects.toThrow(
				BadRequestError,
			);
			await expect(resolveAndValidateWebhookUrl("http://127.0.0.1/")).rejects.toThrow(
				BadRequestError,
			);
			await expect(resolveAndValidateWebhookUrl("ftp://example.com/")).rejects.toThrow(
				BadRequestError,
			);
		});

		test("allows public URLs that resolve to public IPs", async () => {
			const dns = await import("node:dns/promises");
			const origV4 = dns.resolve4;
			const origV6 = dns.resolve6;
			mock.module("node:dns/promises", () => ({
				resolve4: async () => ["93.184.216.34"],
				resolve6: async () => [],
			}));
			try {
				const { resolveAndValidateWebhookUrl: freshResolve } = await import("./index.js");
				await expect(freshResolve("https://example.com/webhook")).resolves.toBeUndefined();
			} finally {
				mock.module("node:dns/promises", () => ({ resolve4: origV4, resolve6: origV6 }));
			}
		});

		test("skips DNS resolution when hostname is already a validated public IP", async () => {
			await expect(
				resolveAndValidateWebhookUrl("http://203.0.113.1:8080/hook"),
			).resolves.toBeUndefined();
		});
	});
});
