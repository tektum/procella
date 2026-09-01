// @procella/esc — EvaluatorClient: invokes the Go Lambda (esc-eval/) that
// embeds github.com/pulumi/esc to evaluate a composed environment.
//
// Two implementations:
// - UnimplementedEvaluatorClient: placeholder that throws on invocation.
// - LambdaEvaluatorClient: production client using @aws-sdk/client-lambda
//   for synchronous Lambda invoke (RequestResponse). All inputs come
//   pre-resolved in the payload — the Lambda never reads DB or network.

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

/** Input for one evaluator invocation. */
export interface EvaluatePayload {
	/** YAML body of the target environment. */
	definition: string;
	/** Pre-resolved imports keyed by `{project}/{env}` — no lazy loading. */
	imports: Record<string, string>;
	/** 32-byte HKDF-derived key (hex) for decrypting envelope-wrapped values. */
	encryptionKeyHex: string;
}

export interface EvaluateDiagnostic {
	severity: "error" | "warning";
	summary: string;
	path?: string[];
}

export interface EvaluateResult {
	values: Record<string, unknown>;
	/** JSON paths marked secret by the evaluator. */
	secrets: string[];
	diagnostics: EvaluateDiagnostic[];
}

export interface EvaluatorClient {
	evaluate(payload: EvaluatePayload): Promise<EvaluateResult>;
}

/** Error thrown when a Lambda evaluator invocation fails. */
export class EvaluatorInvokeError extends Error {
	constructor(message: string, opts?: ErrorOptions) {
		super(message, opts);
		this.name = "EvaluatorInvokeError";
	}
}

/**
 * Placeholder — throws on invocation. Used when no evaluator Lambda is
 * configured (local dev without ESC support).
 */
export class UnimplementedEvaluatorClient implements EvaluatorClient {
	async evaluate(_: EvaluatePayload): Promise<EvaluateResult> {
		throw new Error(
			"EvaluatorClient not implemented — set PROCELLA_ESC_EVALUATOR_FN_NAME to enable ESC evaluation.",
		);
	}
}

/**
 * Local/dev evaluator client — executes the compiled esc-eval bootstrap in
 * stdio mode. Useful for E2E tests and local development without Lambda.
 */
export class StdioEvaluatorClient implements EvaluatorClient {
	private readonly binaryPath: string;

	constructor(opts: { binaryPath: string }) {
		this.binaryPath = opts.binaryPath;
	}

	async evaluate(payload: EvaluatePayload): Promise<EvaluateResult> {
		const proc = Bun.spawn([this.binaryPath], {
			env: { ...process.env, PROCELLA_ESC_STDIO: "1" },
			stdin: new TextEncoder().encode(JSON.stringify(payload)),
			stdout: "pipe",
			stderr: "pipe",
		});

		const [exitCode, stdoutBuf, stderrBuf] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).arrayBuffer(),
			new Response(proc.stderr).arrayBuffer(),
		]);

		const stdout = new TextDecoder().decode(stdoutBuf);
		const stderr = new TextDecoder().decode(stderrBuf);

		if (exitCode !== 0) {
			throw new EvaluatorInvokeError(`esc-eval exited ${exitCode}: ${stderr || stdout}`);
		}

		let parsed: EvaluateResult & { error?: string };
		try {
			parsed = JSON.parse(stdout) as EvaluateResult & { error?: string };
		} catch (cause) {
			throw new EvaluatorInvokeError(
				`esc-eval produced non-JSON stdout: ${cause instanceof Error ? cause.message : String(cause)}`,
				{ cause },
			);
		}

		if (parsed.error) {
			throw new EvaluatorInvokeError(`Evaluator error: ${parsed.error}`);
		}

		return {
			values: parsed.values ?? {},
			secrets: parsed.secrets ?? [],
			diagnostics: parsed.diagnostics ?? [],
		};
	}
}

/**
 * Production evaluator client — invokes the Go Lambda via AWS SDK.
 *
 * Uses synchronous invoke (RequestResponse) with an AbortController timeout
 * set slightly below Lambda's own 60s timeout to get a clean client-side
 * error instead of an opaque gateway timeout.
 */
export class LambdaEvaluatorClient implements EvaluatorClient {
	private readonly client: LambdaClient;
	private readonly functionName: string;
	private readonly timeoutMs: number;

	constructor(opts: { functionName: string; region?: string; timeoutMs?: number }) {
		this.functionName = opts.functionName;
		this.timeoutMs = opts.timeoutMs ?? 55_000;
		this.client =
			opts.region !== undefined ? new LambdaClient({ region: opts.region }) : new LambdaClient();
	}

	async evaluate(payload: EvaluatePayload): Promise<EvaluateResult> {
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), this.timeoutMs);

		try {
			const response = await this.client.send(
				new InvokeCommand({
					FunctionName: this.functionName,
					InvocationType: "RequestResponse",
					Payload: new TextEncoder().encode(JSON.stringify(payload)),
				}),
				{ abortSignal: abort.signal },
			);

			if (response.FunctionError) {
				const errorText = response.Payload
					? new TextDecoder().decode(response.Payload)
					: response.FunctionError;
				throw new EvaluatorInvokeError(`Lambda evaluator error: ${errorText}`);
			}

			if (!response.Payload) {
				throw new EvaluatorInvokeError("Lambda evaluator returned empty response");
			}

			return JSON.parse(new TextDecoder().decode(response.Payload)) as EvaluateResult;
		} catch (error) {
			if (error instanceof EvaluatorInvokeError) throw error;
			throw new EvaluatorInvokeError(
				error instanceof Error ? error.message : "Unknown Lambda invoke error",
				{ cause: error },
			);
		} finally {
			clearTimeout(timer);
		}
	}
}
