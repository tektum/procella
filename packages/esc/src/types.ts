// @procella/esc — Domain types for environments, revisions, and sessions.

export interface EscProject {
	id: string;
	tenantId: string;
	name: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface EscEnvironment {
	id: string;
	projectId: string;
	name: string;
	yamlBody: string;
	currentRevisionNumber: number;
	createdBy: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface EscEnvironmentRevision {
	id: string;
	environmentId: string;
	revisionNumber: number;
	yamlBody: string;
	createdBy: string;
	createdAt: Date;
}

/**
 * Materialized output of a single `open` call. Stored encrypted in
 * `esc_sessions`. Fetched via GET /open/{sessionId} before TTL expiry.
 */
export interface EscSession {
	id: string;
	environmentId: string;
	revisionId: string;
	/** Base64-encoded AES-256-GCM ciphertext of resolved values JSON. */
	resolvedValuesCiphertext: string;
	openedAt: Date;
	expiresAt: Date;
	closedAt: Date | null;
}

export interface CreateEnvironmentInput {
	projectName: string;
	name: string;
	yamlBody: string;
}

export interface CloneEnvironmentInput {
	project: string;
	name: string;
	version?: number;
	preserveHistory?: boolean;
	preserveAccess?: boolean;
	preserveEnvironmentTags?: boolean;
	preserveRevisionTags?: boolean;
}

export interface UpdateEnvironmentInput {
	yamlBody: string;
	expectedRevisionNumber?: number;
}

export interface OrgEnvironmentSummary {
	organization: string;
	project: string;
	name: string;
}

export interface ListAllEnvironmentsOptions {
	orgFilter?: string;
	projectFilter?: string;
	after?: string;
}

export interface ListAllEnvironmentsResult {
	environments: OrgEnvironmentSummary[];
	nextToken: string;
}

export interface EscCliDiagnostic {
	summary: string;
	detail?: string;
}

export interface ValidateYamlResult {
	values: Record<string, unknown>;
	diagnostics: EscCliDiagnostic[];
}

export interface EscRevisionTag {
	name: string;
	revisionNumber: number;
	createdBy: string;
	createdAt: Date;
}

export type DraftStatus = "open" | "applied" | "discarded";

export interface EscDraft {
	id: string;
	environmentId: string;
	yamlBody: string;
	description: string;
	createdBy: string;
	status: DraftStatus;
	appliedRevisionId: string | null;
	appliedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Output the CLI and dashboard receive from /open. Values include resolved
 * plaintext for everything (including secrets); the `secrets` array lists
 * the JSON paths flagged sensitive so clients can mask them at render time.
 */
/** Selects what `openSession` evaluates. Defaults to the environment's current revision. */
export interface OpenSessionOptions {
	/** Published revision number to evaluate. */
	revision?: number;
	/** Open draft (change request) to evaluate instead of a published revision. */
	draftId?: string;
}

export interface OpenSessionResult {
	sessionId: string;
	values: Record<string, unknown>;
	/**
	 * JSON paths of values flagged secret by the evaluator. Object keys are
	 * dot-delimited; array elements use bracket notation. Example shapes:
	 *   "foo"          (top-level key)
	 *   "foo.bar"      (nested key)
	 *   "list[0]"      (array element)
	 *   "list[0].name" (nested key inside array element)
	 */
	secrets: string[];
	expiresAt: Date;
}
