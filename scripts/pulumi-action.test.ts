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
const step = action.runs.steps[0] as CompositeStep;

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

/**
 * Resolves the inputs the nested official action receives for a given caller
 * `with:` block, the way the composite runner does: declared defaults fill
 * omitted inputs, then the step's `with` expressions are evaluated.
 */
function forwardedInputs(callerWith: Record<string, string> = {}): Record<string, string> {
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

	const resolved: Record<string, string> = {};
	for (const [name, template] of Object.entries(step.with ?? {})) {
		resolved[name] = evaluate(String(template), { inputs, github: GITHUB_CONTEXT });
	}
	return resolved;
}

describe("actions/pulumi delegation", () => {
	test("runs the official Pulumi action as a single SHA-pinned composite step", () => {
		expect(action.runs.using).toBe("composite");
		expect(action.runs.steps).toHaveLength(1);
		expect(step.id).toBe("pulumi");
		expect(step.uses).toBe(`pulumi/actions@${PINNED_UPSTREAM_SHA}`);
		expect(step.uses).toMatch(/^pulumi\/actions@[0-9a-f]{40}$/);
	});

	test("annotates the pin with the upstream release it tracks", () => {
		expect(source).toContain(
			`uses: pulumi/actions@${PINNED_UPSTREAM_SHA} # ${PINNED_UPSTREAM_TAG}`,
		);
	});

	test("re-exports the upstream command output", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression, not a JS template
		expect(action.outputs.output?.value).toBe("${{ steps.pulumi.outputs.output }}");
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

	test("cloud-url is the only declared default that diverges from upstream", () => {
		const diverging = Object.entries(action.inputs)
			.filter(([name, spec]) => (spec.default ?? null) !== UPSTREAM_INPUT_DEFAULTS[name])
			.map(([name]) => name);
		expect(diverging).toEqual(["cloud-url"]);
	});
});

describe("actions/pulumi forwarding surface", () => {
	test("declares exactly the pinned upstream input surface", () => {
		expect(Object.keys(action.inputs).sort()).toEqual(Object.keys(UPSTREAM_INPUT_DEFAULTS).sort());
	});

	test("declares every input as optional, matching upstream", () => {
		const required = Object.entries(action.inputs)
			.filter(([, spec]) => spec.required === true)
			.map(([name]) => name);
		expect(required).toEqual([]);
	});

	test("forwards every declared input to the matching upstream input", () => {
		const sentinels: Record<string, string> = {};
		for (const name of Object.keys(action.inputs)) {
			sentinels[name] = `sentinel:${name}`;
		}
		expect(forwardedInputs(sentinels)).toEqual(sentinels);
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
