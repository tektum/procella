import { describe, expect, test } from "bun:test";

/**
 * Contract tests for the repository-hosted `actions/pulumi` composite action.
 *
 * GitHub composite actions cannot forward undeclared inputs, so the action must
 * declare and forward the pinned upstream surface explicitly. These tests model
 * the runner's two-phase input resolution (apply declared defaults, then
 * evaluate the nested step's `with` expressions) and assert the resolved values
 * the official Pulumi action actually receives.
 */

const ACTION_PATH = new URL("../actions/pulumi/action.yml", import.meta.url).pathname;

const PROCELLA_CLOUD_URL = "https://api.procella.cloud/api";
const PINNED_UPSTREAM_SHA = "8e5e406f4007fca908480587cb9893c07090f58d";
const PINNED_UPSTREAM_TAG = "v7.0.0";
const PINNED_AUTH_SHA = "141415910c3beb54e03b48e9057c204c97b956f2";
const PINNED_AUTH_TAG = "v2.1.0";
const PROCELLA_ONLY_INPUTS = ["oidc-organization"];

/**
 * Input surface of `pulumi/actions` at {@link PINNED_UPSTREAM_SHA}; `null` means
 * upstream declares no default. Every upstream input is optional.
 *
 * Re-sync after bumping the pin in `actions/pulumi/action.yml`:
 *   git clone https://github.com/pulumi/actions && cd actions
 *   git show <new-sha>:action.yml
 *
 * Keeping the snapshot here makes an un-synced pin bump a deterministic offline
 * test failure instead of a silently dropped or malformed nested input.
 */
const UPSTREAM_INPUT_DEFAULTS: Record<string, string | null> = {
	command: null,
	"stack-name": null,
	"pulumi-version": null,
	"pulumi-version-file": null,
	"work-dir": "./",
	"comment-on-pr": "false",
	"comment-on-pr-number": null,
	"comment-on-summary": "false",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression, not a JS template
	"github-token": "${{ github.token }}",
	"cloud-url": null,
	"secrets-provider": null,
	parallel: null,
	message: null,
	"config-map": null,
	"expect-no-changes": "false",
	diff: "false",
	replace: null,
	exclude: null,
	"exclude-dependents": "false",
	target: null,
	"target-dependents": "false",
	policyPacks: null,
	policyPackConfigs: null,
	refresh: "false",
	upsert: "false",
	remove: "false",
	"edit-pr-comment": "true",
	color: "auto",
	"exclude-protected": "false",
	plan: null,
	"suppress-outputs": "false",
	"suppress-progress": "false",
	"always-include-summary": "false",
	"continue-on-error": "false",
	"log-verbosity": null,
	"log-flow": "false",
	debug: "false",
};

/** Stand-in for the caller workflow's `github` context during resolution. */
const GITHUB_CONTEXT: Record<string, string> = { token: "ghs-caller-workflow-token" };

interface InputSpec {
	description?: string;
	required?: boolean;
	default?: string;
}

interface CompositeStep {
	id?: string;
	if?: string;
	uses?: string;
	with?: Record<string, string>;
}

interface ActionMetadata {
	name: string;
	description: string;
	inputs: Record<string, InputSpec>;
	outputs: Record<string, { description?: string; value?: string }>;
	runs: { using: string; steps: CompositeStep[] };
}

const source = await Bun.file(ACTION_PATH).text();
const action = Bun.YAML.parse(source) as ActionMetadata;
const authStep = action.runs.steps[0] as CompositeStep;
const pulumiStep = action.runs.steps[1] as CompositeStep;

const EXPRESSION = /\$\{\{\s*([A-Za-z]+)\.([A-Za-z0-9_-]+)\s*\}\}/g;

/** Substitutes `${{ <scope>.<key> }}` references the runner would evaluate. */
function evaluate(template: string, scopes: Record<string, Record<string, string>>): string {
	return template.replace(EXPRESSION, (_match, scope: string, key: string) => {
		const values = scopes[scope];
		if (!values || !(key in values)) {
			throw new Error(`unresolvable expression: ${scope}.${key}`);
		}
		return values[key] as string;
	});
}

/** Resolves the composite inputs after applying defaults and caller values. */
function resolvedActionInputs(callerWith: Record<string, string> = {}): Record<string, string> {
	const undeclared = Object.keys(callerWith).filter((name) => !(name in action.inputs));
	if (undeclared.length > 0) {
		throw new Error(`composite actions cannot forward undeclared inputs: ${undeclared.join(", ")}`);
	}

	const inputs: Record<string, string> = {};
	for (const [name, spec] of Object.entries(action.inputs)) {
		const supplied = callerWith[name];
		inputs[name] =
			supplied !== undefined
				? supplied
				: spec.default === undefined
					? ""
					: evaluate(spec.default, { github: GITHUB_CONTEXT });
	}
	return inputs;
}

/** Resolves the `with` values a nested action step receives. */
function stepInputs(
	step: CompositeStep,
	callerWith: Record<string, string> = {},
): Record<string, string> {
	const inputs = resolvedActionInputs(callerWith);
	const resolved: Record<string, string> = {};
	for (const [name, template] of Object.entries(step.with ?? {})) {
		resolved[name] = evaluate(String(template), { inputs, github: GITHUB_CONTEXT });
	}
	return resolved;
}

function forwardedInputs(callerWith: Record<string, string> = {}): Record<string, string> {
	return stepInputs(pulumiStep, callerWith);
}

describe("actions/pulumi delegation", () => {
	test("authenticates before running the official Pulumi action", () => {
		expect(action.runs.using).toBe("composite");
		expect(action.runs.steps).toHaveLength(2);
		expect(authStep.id).toBe("procella-auth");
		expect(authStep.uses).toBe(`pulumi/auth-actions@${PINNED_AUTH_SHA}`);
		expect(authStep.uses).toMatch(/^pulumi\/auth-actions@[0-9a-f]{40}$/);
		expect(pulumiStep.id).toBe("pulumi");
		expect(pulumiStep.uses).toBe(`pulumi/actions@${PINNED_UPSTREAM_SHA}`);
		expect(pulumiStep.uses).toMatch(/^pulumi\/actions@[0-9a-f]{40}$/);
	});

	test("annotates both pins with their upstream releases", () => {
		expect(source).toContain(`uses: pulumi/auth-actions@${PINNED_AUTH_SHA} # ${PINNED_AUTH_TAG}`);
		expect(source).toContain(
			`uses: pulumi/actions@${PINNED_UPSTREAM_SHA} # ${PINNED_UPSTREAM_TAG}`,
		);
	});

	test("re-exports the upstream command output", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression, not a JS template
		expect(action.outputs.output?.value).toBe("${{ steps.pulumi.outputs.output }}");
	});
});

describe("actions/pulumi OIDC authentication", () => {
	test("enables OIDC only when an organization is explicitly supplied", () => {
		expect(action.inputs["oidc-organization"]?.required).toBe(false);
		expect(action.inputs["oidc-organization"]?.default).toBeUndefined();
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression, not a JS template
		expect(authStep.if).toBe("${{ inputs.oidc-organization != '' }}");
		expect(stepInputs(authStep, { "stack-name": "acme/project/dev" }).organization).toBe("");
	});

	test("requests an organization token and exports it for the Pulumi step", () => {
		expect(stepInputs(authStep, { "oidc-organization": "acme" })).toEqual({
			organization: "acme",
			"requested-token-type": "urn:pulumi:token-type:access_token:organization",
			"export-environment-variables": "true",
			"cloud-url": PROCELLA_CLOUD_URL,
		});
	});

	test("forwards the configured backend URL to OIDC authentication", () => {
		const cloudUrl = "https://procella.internal.example.com/api";
		expect(
			stepInputs(authStep, { "oidc-organization": "acme", "cloud-url": cloudUrl })["cloud-url"],
		).toBe(cloudUrl);
	});
});

describe("actions/pulumi cloud-url", () => {
	test("defaults to Procella production when the caller omits cloud-url", () => {
		expect(action.inputs["cloud-url"]?.default).toBe(PROCELLA_CLOUD_URL);
		expect(forwardedInputs()["cloud-url"]).toBe(PROCELLA_CLOUD_URL);
	});

	test("forwards an explicit cloud-url verbatim", () => {
		const override = "https://pulumi.internal.example.com/api";
		expect(forwardedInputs({ "cloud-url": override })["cloud-url"]).toBe(override);
	});

	// An empty value is forwarded as-is, which makes upstream run bare `pulumi login`
	// (Pulumi Cloud). It does not preserve an existing backend selection.
	test("forwards an explicitly emptied cloud-url as an empty value", () => {
		expect(forwardedInputs({ "cloud-url": "" })["cloud-url"]).toBe("");
	});

	test("cloud-url is the only upstream default that diverges", () => {
		const diverging = Object.entries(UPSTREAM_INPUT_DEFAULTS)
			.filter(([name, defaultValue]) => (action.inputs[name]?.default ?? null) !== defaultValue)
			.map(([name]) => name);
		expect(diverging).toEqual(["cloud-url"]);
	});
});

describe("actions/pulumi forwarding surface", () => {
	test("declares the pinned upstream surface plus explicit Procella-only inputs", () => {
		const upstreamInputs = Object.keys(UPSTREAM_INPUT_DEFAULTS);
		expect(Object.keys(action.inputs).filter((name) => !upstreamInputs.includes(name))).toEqual(
			PROCELLA_ONLY_INPUTS,
		);
		expect(upstreamInputs.every((name) => name in action.inputs)).toBe(true);
	});

	test("declares every input as optional, matching upstream", () => {
		const required = Object.entries(action.inputs)
			.filter(([, spec]) => spec.required === true)
			.map(([name]) => name);
		expect(required).toEqual([]);
	});

	test("forwards every upstream input one-to-one and no Procella-only input", () => {
		const sentinels: Record<string, string> = {};
		for (const name of Object.keys(UPSTREAM_INPUT_DEFAULTS)) {
			sentinels[name] = `sentinel:${name}`;
		}
		expect(forwardedInputs(sentinels)).toEqual(sentinels);
		expect(forwardedInputs({ "oidc-organization": "acme" })).not.toHaveProperty(
			"oidc-organization",
		);
	});

	test("forwards the caller workflow token when github-token is omitted", () => {
		expect(forwardedInputs()["github-token"]).toBe(GITHUB_CONTEXT.token);
	});

	test("resolves every forwarded value, leaving no unevaluated expression", () => {
		for (const [name, value] of Object.entries(forwardedInputs())) {
			expect(value, `input ${name} left an unevaluated expression`).not.toContain("${{");
		}
	});

	test("rejects caller inputs the composite action cannot forward", () => {
		expect(() => forwardedInputs({ "not-an-input": "x" })).toThrow(
			/cannot forward undeclared inputs: not-an-input/,
		);
	});
});
