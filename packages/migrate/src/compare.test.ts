import { describe, expect, test } from "bun:test";
import {
	type BatchSecretDecrypter,
	compareDeploymentState,
	describeFirstMismatch,
	SECRET_SIGNATURE,
	SECRET_SIGNATURE_KEY,
} from "./compare.js";
import type { UntypedDeployment } from "./types.js";

type ResourceFixture = NonNullable<UntypedDeployment["deployment"]["resources"]>[number];

function plaintextSecret(value: string): Record<string, unknown> {
	return { [SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE, plaintext: JSON.stringify(value) };
}

function ciphertextSecret(ciphertext: string): Record<string, unknown> {
	return { [SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE, ciphertext };
}

/** A decrypter matching real Pulumi service-provider re-encryption of the same logical value. */
function decrypterFor(map: Record<string, string>): BatchSecretDecrypter {
	return async (ciphertexts) => {
		const result = new Map<string, string>();
		for (const ct of ciphertexts) {
			if (ct in map) result.set(ct, JSON.stringify(map[ct]));
		}
		return result;
	};
}

function baseDeployment(overrides?: Partial<UntypedDeployment["deployment"]>): UntypedDeployment {
	return {
		version: 3,
		deployment: {
			manifest: { time: "2026-01-01T00:00:00Z", magic: "abc", version: "3.100.0" },
			secrets_providers: { type: "passphrase", state: { salt: "source-salt" } },
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					id: "res-1",
					inputs: { size: "small" },
					outputs: { endpoint: "https://api.example.test" },
					dependencies: [],
				},
			],
			pending_operations: [],
			...overrides,
		},
	};
}

function cloneDeployment(source: UntypedDeployment): UntypedDeployment {
	return JSON.parse(JSON.stringify(source));
}

function firstResource(deployment: UntypedDeployment): ResourceFixture {
	const resource = deployment.deployment.resources?.[0];
	if (!resource) throw new Error("test fixture is missing deployment.resources[0]");
	return resource;
}

function manifestOf(deployment: UntypedDeployment): {
	time: string;
	magic: string;
	version: string;
} {
	const manifest = deployment.deployment.manifest;
	if (!manifest) throw new Error("test fixture is missing deployment.manifest");
	return manifest;
}

describe("compareDeploymentState — baseline", () => {
	test("identical deployments match", async () => {
		const source = baseDeployment();
		const target = cloneDeployment(source);
		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(true);
		expect(result.unverifiable).toBe(false);
		expect(result.mismatches).toEqual([]);
	});
});

describe("compareDeploymentState — material corruption with unchanged count/URN", () => {
	test("altered resource id is rejected", async () => {
		const source = baseDeployment();
		const target = cloneDeployment(source);
		firstResource(target).id = "res-corrupted";

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(result.unverifiable).toBe(false);
		expect(result.sourceResourceCount).toBe(result.targetResourceCount);
		expect(result.mismatches.some((m) => m.kind === "field-mismatch" && m.path === "id")).toBe(
			true,
		);
	});

	test("altered output value is rejected", async () => {
		const source = baseDeployment();
		const target = cloneDeployment(source);
		firstResource(target).outputs = { endpoint: "https://attacker.example.test" };

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(
			result.mismatches.some((m) => m.kind === "field-mismatch" && m.path === "outputs.endpoint"),
		).toBe(true);
	});

	test("altered dependency edge is rejected", async () => {
		const source = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					id: "res-1",
					inputs: {},
					outputs: {},
					dependencies: ["urn:pulumi:prod::api::pkg:type::dep-a"],
				},
			],
		});
		const target = cloneDeployment(source);
		firstResource(target).dependencies = ["urn:pulumi:prod::api::pkg:type::dep-b"];

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(
			result.mismatches.some((m) => m.kind === "field-mismatch" && m.path === "dependencies[0]"),
		).toBe(true);
	});

	test("altered pending operation is rejected", async () => {
		const source = baseDeployment({
			pending_operations: [
				{ resource: { urn: "urn:pulumi:prod::api::pkg:type::res" }, type: "creating" },
			],
		});
		const target = cloneDeployment(source);
		// Simulates the real `pulumi stack import` behavior of discarding pending operations
		// (pkg/cmd/pulumi/stack/io.go SaveSnapshot) — silently losing this is exactly the bug
		// count-only verification used to hide.
		target.deployment.pending_operations = [];

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(result.mismatches.some((m) => m.path === "pending_operations")).toBe(true);
	});

	test("altered secret logical value is rejected", async () => {
		const canary = `canary-${crypto.randomUUID()}`;
		const source = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					id: "res-1",
					inputs: {},
					outputs: { password: plaintextSecret(canary) },
					dependencies: [],
				},
			],
		});
		const target = cloneDeployment(source);
		const tamperedCiphertext = Buffer.from(JSON.stringify("tampered-value")).toString("base64");
		firstResource(target).outputs = { password: ciphertextSecret(tamperedCiphertext) };

		const result = await compareDeploymentState(source, target, {
			decryptTarget: decrypterFor({ [tamperedCiphertext]: "tampered-value" }),
		});

		expect(result.match).toBe(false);
		const detail = JSON.stringify(result.mismatches);
		expect(detail).not.toContain(canary);
		expect(detail).not.toContain("tampered-value");
		expect(detail).not.toContain(tamperedCiphertext);
	});

	test("resource present only on source is rejected", async () => {
		const base = baseDeployment();
		const source = baseDeployment({
			resources: [
				...(base.deployment.resources ?? []),
				{ urn: "urn:pulumi:prod::api::pkg:type::extra", type: "pkg:type" },
			],
		});
		const target = baseDeployment();

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(
			result.mismatches.some(
				(m) => m.kind === "missing-on-target" && m.urn === "urn:pulumi:prod::api::pkg:type::extra",
			),
		).toBe(true);
	});

	test("duplicate URN group of differing size is rejected", async () => {
		const base = baseDeployment();
		const dup = {
			urn: "urn:pulumi:prod::api::pkg:type::replaced",
			type: "pkg:type",
			delete: true,
		};
		const source = baseDeployment({
			resources: [...(base.deployment.resources ?? []), dup, { ...dup }],
		});
		const target = baseDeployment({
			resources: [...(base.deployment.resources ?? []), dup],
		});

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(result.mismatches.some((m) => m.kind === "duplicate-urn-count")).toBe(true);
	});

	test("unrecognised deployment-level field is preserved and compared", async () => {
		const source = baseDeployment({ future_field: { flavor: "blue" } });
		const target = baseDeployment({ future_field: { flavor: "green" } });

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(result.mismatches.some((m) => m.path.startsWith("future_field"))).toBe(true);
	});

	test("missing empty unrecognised deployment field is rejected", async () => {
		const source = baseDeployment({ future_field: false });
		const target = baseDeployment();

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(result.mismatches.some((m) => m.path === "future_field")).toBe(true);
	});

	test("missing empty unrecognised resource field is rejected", async () => {
		const source = baseDeployment();
		firstResource(source).future_field = false;
		const target = cloneDeployment(source);
		delete firstResource(target).future_field;

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(result.mismatches.some((m) => m.path === "future_field")).toBe(true);
	});

	test("unrecognised snapshot metadata is preserved and compared", async () => {
		const source = baseDeployment({ metadata: { future_field: "keep-me" } });
		const target = baseDeployment({ metadata: {} });

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(result.mismatches.some((m) => m.path === "metadata.future_field")).toBe(true);
	});

	test("absent and empty snapshot metadata are equivalent", async () => {
		const source = baseDeployment();
		const target = baseDeployment({ metadata: {} });

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(true);
	});
});

describe("compareDeploymentState — legitimate target-provider rebinding", () => {
	test("equivalent state after correct target re-encryption succeeds", async () => {
		const canary = `canary-${crypto.randomUUID()}`;
		const source = baseDeployment({
			secrets_providers: { type: "passphrase", state: { salt: "source-salt" } },
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					id: "res-1",
					inputs: { database: plaintextSecret(canary) },
					outputs: {},
					dependencies: [],
				},
			],
		});
		const target = cloneDeployment(source);
		target.deployment.secrets_providers = {
			type: "service",
			state: {
				url: "https://target.example.test",
				owner: "target-org",
				project: "api",
				stack: "prod",
			},
		};
		// Same logical value, genuinely different (target-encrypted) ciphertext bytes.
		const realCiphertext = Buffer.from(`${Math.random()}:${canary}`).toString("base64");
		firstResource(target).inputs = { database: ciphertextSecret(realCiphertext) };

		const result = await compareDeploymentState(source, target, {
			decryptTarget: decrypterFor({ [realCiphertext]: canary }),
		});

		expect(result.match).toBe(true);
		expect(result.unverifiable).toBe(false);
	});

	test("manifest.time difference alone is normalized away", async () => {
		const source = baseDeployment();
		const target = cloneDeployment(source);
		manifestOf(target).time = "2099-12-31T23:59:59Z";

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(true);
	});

	test("manifest.version difference is still caught", async () => {
		const source = baseDeployment();
		const target = cloneDeployment(source);
		manifestOf(target).version = "3.0.0-corrupted";

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(result.mismatches.some((m) => m.path === "manifest.version")).toBe(true);
	});
});

describe("compareDeploymentState — unverifiable states never certify a match", () => {
	test("ciphertext secret with no decrypter fails clearly, not silently", async () => {
		const canary = `canary-${crypto.randomUUID()}`;
		const source = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					outputs: { password: plaintextSecret(canary) },
				},
			],
		});
		const ciphertext = Buffer.from(JSON.stringify(canary)).toString("base64");
		const target = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					outputs: { password: ciphertextSecret(ciphertext) },
				},
			],
		});

		const result = await compareDeploymentState(source, target);

		expect(result.match).toBe(false);
		expect(result.unverifiable).toBe(true);
		expect(result.mismatches.some((m) => m.kind === "unverifiable-secret")).toBe(true);
		const detail = JSON.stringify(result.mismatches);
		expect(detail).not.toContain(canary);
		expect(detail).not.toContain(ciphertext);
	});

	test("decrypter that cannot resolve the ciphertext fails clearly", async () => {
		const ciphertext = Buffer.from(JSON.stringify("value")).toString("base64");
		const source = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pkg:type::a",
					type: "pkg:type",
					outputs: { secret: ciphertextSecret(ciphertext) },
				},
			],
		});
		const target = cloneDeployment(source);

		const result = await compareDeploymentState(source, target, {
			decryptSource: async () => new Map(),
			decryptTarget: async () => new Map(),
		});

		expect(result.match).toBe(false);
		expect(result.unverifiable).toBe(true);
	});

	test("decrypter throwing is treated as unverifiable, not a crash", async () => {
		const ciphertext = Buffer.from(JSON.stringify("value")).toString("base64");
		const source = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pkg:type::a",
					type: "pkg:type",
					outputs: { secret: ciphertextSecret(ciphertext) },
				},
			],
		});
		const target = cloneDeployment(source);

		const result = await compareDeploymentState(source, target, {
			decryptTarget: async () => {
				throw new Error("network error");
			},
		});

		expect(result.match).toBe(false);
		expect(result.unverifiable).toBe(true);
	});

	test("unsupported deployment schema version fails clearly", async () => {
		const source = baseDeployment();
		const target = { ...cloneDeployment(source), version: 99 };

		const result = await compareDeploymentState(source, target);

		expect(result.match).toBe(false);
		expect(result.unverifiable).toBe(true);
		expect(result.mismatches.some((m) => m.kind === "unsupported-schema")).toBe(true);
	});
});

describe("compareDeploymentState — hardening against adversarial/coincidental JSON shapes", () => {
	test("secret value containing a __proto__ key is compared, not swallowed by prototype pollution", async () => {
		// Raw JSON text with a literal "__proto__" own key, as it would arrive over the
		// wire — bypasses the plaintextSecret() helper, which JSON.stringifies a string
		// and could never itself produce this shape.
		const source = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					outputs: {
						password: {
							[SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE,
							plaintext: '{"__proto__":{"v":1}}',
						},
					},
				},
			],
		});
		const target = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					outputs: {
						password: {
							[SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE,
							plaintext: '{"__proto__":{"v":2}}',
						},
					},
				},
			],
		});

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
	});

	test("ordinary JSON shaped like the internal secret marker cannot bypass comparison", async () => {
		// Not a real Pulumi secret envelope (no SECRET_SIGNATURE_KEY) — plain resource
		// output data that happens to have a string key matching the comparator's old,
		// unbranded internal wrapper shape.
		const source = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					outputs: { config: { __resolvedSecret: true, value: "same", extra: "before" } },
				},
			],
		});
		const target = cloneDeployment(source);
		firstResource(target).outputs = {
			config: { __resolvedSecret: true, value: "same", extra: "after" },
		};

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
	});

	test("mismatch diagnostics never reveal a decrypted structured secret's own key names", async () => {
		const source = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					outputs: {
						credentials: {
							[SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE,
							plaintext: JSON.stringify({ "private-token": "aaa" }),
						},
					},
				},
			],
		});
		const target = cloneDeployment(source);
		firstResource(target).outputs = {
			credentials: {
				[SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE,
				plaintext: JSON.stringify({ "private-token": "bbb" }),
			},
		};

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		const serialized = JSON.stringify(result.mismatches);
		expect(serialized).not.toContain("private-token");
		expect(serialized).not.toContain("aaa");
		expect(serialized).not.toContain("bbb");
		// Points at the outer secret's own path, never a descendant key inside it.
		expect(result.mismatches.some((m) => m.path === "outputs.credentials")).toBe(true);
	});

	test("duplicate-URN pairing normalizes omitempty-equivalent fields before sorting", async () => {
		const base = baseDeployment();
		const dupUrn = "urn:pulumi:prod::api::pkg:type::replaced";
		const source = baseDeployment({
			resources: [
				...(base.deployment.resources ?? []),
				{ urn: dupUrn, type: "pkg:type", id: "new", delete: false },
				{ urn: dupUrn, type: "pkg:type", id: "old", delete: true },
			],
		});
		const target = baseDeployment({
			resources: [
				...(base.deployment.resources ?? []),
				// The live resource's `delete: false` is dropped, exactly as the real wire
				// format (`,omitempty`) would — logically identical to the source.
				{ urn: dupUrn, type: "pkg:type", id: "new" },
				{ urn: dupUrn, type: "pkg:type", id: "old", delete: true },
			],
		});

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(true);
	});

	test("path field identifies the exact missing non-secret field, not its parent", async () => {
		const source = baseDeployment();
		const target = cloneDeployment(source);
		firstResource(target).outputs = {}; // "endpoint" key entirely missing on target

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(result.mismatches.some((m) => m.path === "outputs.endpoint")).toBe(true);
		expect(result.mismatches.some((m) => m.path === "outputs")).toBe(false);
	});

	test("one comparison reports an exact non-secret path and a redacted secret-only path together", async () => {
		const source = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					outputs: {
						endpoint: "https://api.example.test",
						credentials: {
							[SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE,
							plaintext: JSON.stringify({ "private-token": "aaa" }),
						},
					},
				},
			],
		});
		const target = cloneDeployment(source);
		firstResource(target).outputs = {
			// Non-secret: "endpoint" is genuinely dropped (not empty-equivalent).
			// Secret: same envelope shape, different decrypted structured value.
			credentials: {
				[SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE,
				plaintext: JSON.stringify({ "private-token": "bbb" }),
			},
		};

		const result = await compareDeploymentState(source, target);

		expect(result.match).toBe(false);
		expect(result.mismatches.some((m) => m.path === "outputs.endpoint")).toBe(true);
		expect(result.mismatches.some((m) => m.path === "outputs.credentials")).toBe(true);
		expect(result.mismatches.some((m) => m.path === "outputs")).toBe(false);
		const serialized = JSON.stringify(result.mismatches);
		expect(serialized).not.toContain("private-token");
		expect(serialized).not.toContain("aaa");
		expect(serialized).not.toContain("bbb");
	});

	test("duplicate-URN pairing disambiguates empty-equivalent ties regardless of declared order", async () => {
		const base = baseDeployment();
		const dupUrn = "urn:pulumi:prod::api::pkg:type::replaced";
		const source = baseDeployment({
			resources: [
				...(base.deployment.resources ?? []),
				{ urn: dupUrn, type: "pkg:type", id: "same-id", dependencies: [] },
				{ urn: dupUrn, type: "pkg:type", id: "same-id", dependencies: null },
			],
		});
		const target = baseDeployment({
			resources: [
				...(base.deployment.resources ?? []),
				// Declared in the opposite order from source. Empty and null dependency
				// slices both normalize away under Go's `omitempty`, so the raw signature
				// must disambiguate the normalized tie before comparison.
				{ urn: dupUrn, type: "pkg:type", id: "same-id", dependencies: null },
				{ urn: dupUrn, type: "pkg:type", id: "same-id", dependencies: [] },
			],
		});

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(true);
	});

	test("duplicate-URN pairing never crosses a resolved secret with an ordinary field", async () => {
		const base = baseDeployment();
		const dupUrn = "urn:pulumi:prod::api::pkg:type::replaced";
		const source = baseDeployment({
			resources: [
				...(base.deployment.resources ?? []),
				{ urn: dupUrn, type: "pkg:type", id: "same-id", data: plaintextSecret("hello") },
				{ urn: dupUrn, type: "pkg:type", id: "same-id", data: { value: "hello" } },
			],
		});
		const target = baseDeployment({
			resources: [
				...(base.deployment.resources ?? []),
				// Declared in the opposite order. A resolved secret `{value: "hello"}`
				// (after unwrapping) is textually indistinguishable from the ordinary
				// `{value: "hello"}` field to a signature blind to the wrapper's brand.
				{ urn: dupUrn, type: "pkg:type", id: "same-id", data: { value: "hello" } },
				{ urn: dupUrn, type: "pkg:type", id: "same-id", data: plaintextSecret("hello") },
			],
		});

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(true);
	});

	test("an unverifiable secret in a top-level field is never treated as empty/omitted", async () => {
		const ciphertext = Buffer.from(JSON.stringify("value")).toString("base64");
		// A hypothetical unrecognised deployment-level field whose value is itself a
		// secret envelope this comparator cannot decrypt (no decrypter configured).
		const source = baseDeployment({ custom_field: ciphertextSecret(ciphertext) });
		const target = baseDeployment();

		const result = await compareDeploymentState(source, target);

		expect(result.match).toBe(false);
	});
});

describe("describeFirstMismatch", () => {
	test("reports the first mismatch and a count of the rest", async () => {
		const source = baseDeployment();
		const target = cloneDeployment(source);
		firstResource(target).id = "corrupted";
		firstResource(target).outputs = { endpoint: "corrupted" };

		const result = await compareDeploymentState(source, target);
		const description = describeFirstMismatch(result);
		expect(description).toContain("urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod");
		expect(description).toMatch(/and \d+ more mismatch/);
	});

	test("reports 'deployments match' when there are no mismatches", async () => {
		const source = baseDeployment();
		const target = cloneDeployment(source);
		const result = await compareDeploymentState(source, target);
		expect(describeFirstMismatch(result)).toBe("deployments match");
	});
});
