// @procella/esc — Pulumi ESC (Environments, Secrets & Config) service.
//
// Implements the backend for the `esc` CLI and the dashboard: YAML-based
// environment definitions with composition (imports) and dynamic credential
// providers. Value resolution is delegated to a Go Lambda (esc-eval/) that
// embeds github.com/pulumi/esc as a library.
//
// Current status: full CRUD, revisions/tags, drafts, openSession/getSession,
// and recursive import resolution are wired up end-to-end through the Go
// evaluator (Lambda + stdio modes). See the procella-yj7 epic for history.

export {
	EvaluatorInvokeError,
	LambdaEvaluatorClient,
	StdioEvaluatorClient,
	UnimplementedEvaluatorClient,
} from "./evaluator-client.js";
export * from "./managed.js";
export * from "./secrets.js";
export * from "./service.js";
export * from "./types.js";
