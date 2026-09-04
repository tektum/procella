import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { resolveGitHubAppSecretNames } from "./github-app-secrets.js";

const TEST_GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
	modulusLength: 2048,
})
	.privateKey.export({ format: "pem", type: "pkcs1" })
	.toString();
const TEST_EC_PRIVATE_KEY = generateKeyPairSync("ec", {
	namedCurve: "P-256",
})
	.privateKey.export({ format: "pem", type: "pkcs8" })
	.toString();

const credentialValues = {
	SST_SECRET_ProcellaGitHubAppId: "12345",
	SST_SECRET_ProcellaGitHubAppPrivateKey: TEST_GITHUB_APP_PRIVATE_KEY,
	SST_SECRET_ProcellaGitHubAppWebhookSecret: "webhook-secret",
};
const enabledSecrets = {
	...credentialValues,
	PROCELLA_GITHUB_APP_ENABLED: "true",
};

describe("GitHub App SST secrets", () => {
	test("does not link the optional integration when every secret is absent", () => {
		expect(resolveGitHubAppSecretNames({})).toBeNull();
		expect(
			resolveGitHubAppSecretNames({
				SST_SECRET_ProcellaGitHubAppId: "",
				SST_SECRET_ProcellaGitHubAppPrivateKey: "",
				SST_SECRET_ProcellaGitHubAppWebhookSecret: "",
			}),
		).toBeNull();
	});

	test("does not infer opt-in from valid secret values", () => {
		expect(resolveGitHubAppSecretNames(credentialValues)).toBeNull();
	});

	test("ignores retained client-ID-shaped values when the workflow opt-in is unset", () => {
		const retainedValues = {
			PROCELLA_GITHUB_APP_ENABLED: "",
			SST_SECRET_ProcellaGitHubAppId: "Iv1.0123456789abcdef",
			SST_SECRET_ProcellaGitHubAppPrivateKey: TEST_GITHUB_APP_PRIVATE_KEY,
			SST_SECRET_ProcellaGitHubAppWebhookSecret: "0123456789abcdef",
		};

		expect(resolveGitHubAppSecretNames(retainedValues)).toBeNull();
		expect(
			resolveGitHubAppSecretNames({
				...retainedValues,
				PROCELLA_GITHUB_APP_ENABLED: "false",
			}),
		).toBeNull();
	});

	test("links every secret when the integration is explicitly enabled and valid", () => {
		expect(resolveGitHubAppSecretNames(enabledSecrets)).toEqual({
			appId: "ProcellaGitHubAppId",
			privateKey: "ProcellaGitHubAppPrivateKey",
			webhookSecret: "ProcellaGitHubAppWebhookSecret",
		});
	});

	test("rejects partial credentials", () => {
		expect(() =>
			resolveGitHubAppSecretNames({
				...enabledSecrets,
				SST_SECRET_ProcellaGitHubAppWebhookSecret: "",
			}),
		).toThrow("requires the ProcellaGitHubAppId");
	});

	test("rejects an explicitly enabled workflow with incomplete credentials", () => {
		expect(() =>
			resolveGitHubAppSecretNames({
				PROCELLA_GITHUB_APP_ENABLED: "true",
			}),
		).toThrow("requires the ProcellaGitHubAppId");
	});

	test("rejects retained client-ID-shaped values when the workflow enables them", () => {
		expect(() =>
			resolveGitHubAppSecretNames({
				...enabledSecrets,
				SST_SECRET_ProcellaGitHubAppId: "Iv1.0123456789abcdef",
			}),
		).toThrow("positive safe integer");
	});

	test("rejects an invalid workflow opt-in value", () => {
		expect(() =>
			resolveGitHubAppSecretNames({
				PROCELLA_GITHUB_APP_ENABLED: "yes",
			}),
		).toThrow("must be true, false, or unset");
	});

	test("rejects noncanonical or unsafe App IDs", () => {
		for (const appId of [
			"0",
			"0001",
			"-1",
			"1.0",
			"1e3",
			" 1",
			"9007199254740992",
			"placeholder",
		]) {
			expect(() =>
				resolveGitHubAppSecretNames({
					...enabledSecrets,
					SST_SECRET_ProcellaGitHubAppId: appId,
				}),
			).toThrow("positive safe integer");
		}
	});

	test("rejects whitespace, malformed, placeholder, and non-RSA private keys", () => {
		for (const privateKey of ["   ", "not-a-key", "placeholder", TEST_EC_PRIVATE_KEY]) {
			expect(() =>
				resolveGitHubAppSecretNames({
					...enabledSecrets,
					SST_SECRET_ProcellaGitHubAppPrivateKey: privateKey,
				}),
			).toThrow("valid RSA private key");
		}
	});

	test("rejects a whitespace-only webhook secret", () => {
		expect(() =>
			resolveGitHubAppSecretNames({
				...enabledSecrets,
				SST_SECRET_ProcellaGitHubAppWebhookSecret: " \t\n ",
			}),
		).toThrow("non-whitespace characters");
	});
});
