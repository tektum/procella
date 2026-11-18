import { AesCryptoService } from "@procella/crypto";
import {
	type Database,
	escDrafts,
	escEnvironmentRevisions,
	escEnvironments,
	escProjects,
	escRevisionTags,
	escSessions,
} from "@procella/db";
import { withSpan } from "@procella/telemetry";
import { BadRequestError, ConflictError, NotFoundError, ProcellaError } from "@procella/types";
import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { parseDocument } from "yaml";
import type { EvaluateDiagnostic, EvaluatorClient } from "./evaluator-client.js";
import { encryptEscSecret } from "./secrets.js";
import type {
	CloneEnvironmentInput,
	CreateEnvironmentInput,
	DraftStatus,
	EscCliDiagnostic,
	EscDraft,
	EscEnvironment,
	EscEnvironmentRevision,
	EscProject,
	EscRevisionTag,
	ListAllEnvironmentsOptions,
	ListAllEnvironmentsResult,
	OpenSessionOptions,
	OpenSessionResult,
	OrgEnvironmentSummary,
	UpdateEnvironmentInput,
	ValidateYamlResult,
} from "./types.js";

export interface EscService {
	listProjects(tenantId: string): Promise<EscProject[]>;
	listAllEnvironments(
		tenantId: string,
		options?: ListAllEnvironmentsOptions,
	): Promise<ListAllEnvironmentsResult>;

	createEnvironment(
		tenantId: string,
		input: CreateEnvironmentInput,
		createdBy: string,
	): Promise<EscEnvironment>;
	cloneEnvironment(
		tenantId: string,
		srcProjectName: string,
		srcEnvName: string,
		dest: CloneEnvironmentInput,
		createdBy: string,
	): Promise<EscEnvironment>;
	listEnvironments(tenantId: string, projectName: string): Promise<EscEnvironment[]>;
	getEnvironment(
		tenantId: string,
		projectName: string,
		envName: string,
	): Promise<EscEnvironment | null>;
	updateEnvironment(
		tenantId: string,
		projectName: string,
		envName: string,
		input: UpdateEnvironmentInput,
		updatedBy: string,
	): Promise<EscEnvironment>;
	deleteEnvironment(tenantId: string, projectName: string, envName: string): Promise<void>;

	listRevisions(
		tenantId: string,
		projectName: string,
		envName: string,
	): Promise<EscEnvironmentRevision[]>;
	getRevision(
		tenantId: string,
		projectName: string,
		envName: string,
		revisionNumber: number,
	): Promise<EscEnvironmentRevision | null>;

	openSession(
		tenantId: string,
		projectName: string,
		envName: string,
		options?: OpenSessionOptions,
	): Promise<OpenSessionResult>;
	getSession(
		tenantId: string,
		projectName: string,
		envName: string,
		sessionId: string,
	): Promise<OpenSessionResult | null>;

	// Revision tags
	listRevisionTags(
		tenantId: string,
		projectName: string,
		envName: string,
	): Promise<EscRevisionTag[]>;
	tagRevision(
		tenantId: string,
		projectName: string,
		envName: string,
		revisionNumber: number,
		tagName: string,
		createdBy: string,
	): Promise<void>;
	untagRevision(
		tenantId: string,
		projectName: string,
		envName: string,
		tagName: string,
	): Promise<void>;

	// Environment tags
	getEnvironmentTags(
		tenantId: string,
		projectName: string,
		envName: string,
	): Promise<Record<string, string>>;
	setEnvironmentTags(
		tenantId: string,
		projectName: string,
		envName: string,
		tags: Record<string, string>,
	): Promise<void>;
	updateEnvironmentTags(
		tenantId: string,
		projectName: string,
		envName: string,
		patch: Record<string, string | null>,
	): Promise<void>;

	// Drafts
	createDraft(
		tenantId: string,
		projectName: string,
		envName: string,
		yamlBody: string,
		description: string,
		createdBy: string,
	): Promise<EscDraft>;
	listDrafts(
		tenantId: string,
		projectName: string,
		envName: string,
		status?: DraftStatus,
	): Promise<EscDraft[]>;
	updateDraft(
		tenantId: string,
		projectName: string,
		envName: string,
		draftId: string,
		yamlBody: string,
		expectedUpdatedAtMs?: number,
	): Promise<EscDraft>;
	getDraft(
		tenantId: string,
		projectName: string,
		envName: string,
		draftId: string,
	): Promise<EscDraft | null>;
	applyDraft(
		tenantId: string,
		projectName: string,
		envName: string,
		draftId: string,
		appliedBy: string,
	): Promise<EscDraft>;
	discardDraft(
		tenantId: string,
		projectName: string,
		envName: string,
		draftId: string,
	): Promise<void>;

	validateYaml(yamlBody: string): Promise<ValidateYamlResult>;

	/** Encrypts plaintexts into `fn::secret` ciphertexts for an existing environment. */
	encryptSecrets(
		tenantId: string,
		projectName: string,
		envName: string,
		plaintexts: Uint8Array[],
	): Promise<string[]>;

	gcSweep(): Promise<{ closedCount: number }>;
}

export interface PostgresEscServiceDeps {
	db: Database;
	evaluator: EvaluatorClient;
	encryptionKeyHex: string;
	allowLegacyDecryption?: boolean;
	sessionTtlSeconds?: number;
}

// ============================================================================
// EscEvaluationError — 422 with evaluator diagnostics
// ============================================================================

export class EscEvaluationError extends ProcellaError {
	public readonly diagnostics: EvaluateDiagnostic[];

	constructor(diagnostics: EvaluateDiagnostic[]) {
		const summaries = diagnostics.map((d) => d.summary).join("; ");
		super(`Evaluation failed: ${summaries}`, "ESC_EVALUATION_ERROR", 422);
		this.name = "EscEvaluationError";
		this.diagnostics = diagnostics;
	}
}

export class EscPreconditionFailedError extends ProcellaError {
	constructor() {
		super("Precondition Failed", "PRECONDITION_FAILED", 412);
		this.name = "EscPreconditionFailedError";
	}
}

// ============================================================================
// YAML import-list extraction (no npm yaml dep — evaluator does real parsing)
// ============================================================================

const MAX_IMPORT_DEPTH = 50;

/**
 * Extract `imports:` list from YAML body. Handles:
 * - `imports: [a, b, c]` (flow sequence)
 * - `imports:\n  - a\n  - b` (block sequence)
 * - Missing/empty imports → []
 * - Quoted/unquoted strings
 */
export function extractImports(yamlBody: string): string[] {
	const lines = yamlBody.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i]?.match(/^[ \t]{0,256}imports:[ \t]{0,256}(.*)$/);
		if (!match) continue;

		const rest = match[1].trim();
		if (rest.startsWith("[")) {
			const closeIdx = rest.indexOf("]");
			if (closeIdx === -1) return [];
			const inner = rest.slice(1, closeIdx).trim();
			if (!inner) return [];

			const items: string[] = [];
			let current = "";
			let quote: '"' | "'" | null = null;
			for (const ch of inner) {
				if (quote) {
					if (ch === quote) quote = null;
					else current += ch;
					continue;
				}
				if (ch === '"' || ch === "'") {
					quote = ch;
					continue;
				}
				if (ch === ",") {
					const item = current.trim();
					if (item) items.push(item);
					current = "";
					continue;
				}
				current += ch;
			}
			const tail = current.trim();
			if (tail) items.push(tail);
			return items.map((s) => s.replace(/^["']|["']$/g, "")).filter(Boolean);
		}

		const items: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j] ?? "";
			const trimmed = line.trim();
			if (trimmed === "" || trimmed.startsWith("#")) continue;

			const dashIdx = trimmed.indexOf("-");
			if (dashIdx !== 0) break;
			const afterDash = trimmed.slice(1);
			if (afterDash.length === 0 || (afterDash[0] !== " " && afterDash[0] !== "\t")) break;

			let val = afterDash.trimStart();
			const hashIdx = val.indexOf("#");
			if (hashIdx > 0 && (val[hashIdx - 1] === " " || val[hashIdx - 1] === "\t")) {
				val = val.slice(0, hashIdx).trimEnd();
			}
			const value = val.replace(/^["']|["']$/g, "");
			if (value) items.push(value);
		}
		return items;
	}

	return [];
}

function pgErrorCode(err: unknown): string | undefined {
	let current: unknown = err;
	for (let i = 0; i < 10 && current != null; i++) {
		if (typeof current === "object") {
			const rec = current as Record<string, unknown>;
			for (const key of ["code", "errno"] as const) {
				const val = rec[key];
				const str = typeof val === "number" ? String(val) : val;
				if (typeof str === "string" && /^[0-9A-Z]{5}$/i.test(str)) return str;
			}
			if (Array.isArray(rec.errors)) {
				for (const inner of rec.errors) {
					const found = pgErrorCode(inner);
					if (found) return found;
				}
			}
			if ("cause" in rec) {
				current = rec.cause;
				continue;
			}
		}
		current = undefined;
	}
	return undefined;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateName(kind: "project" | "environment", value: string): void {
	if (!value || value.length > 128) {
		throw new BadRequestError(`${kind} name must be 1-128 characters`);
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
		throw new BadRequestError(`${kind} name may only contain letters, digits, '.', '_', '-'`);
	}
}

function validateTagName(value: string): void {
	if (!value || value.length > 128) {
		throw new BadRequestError("tag name must be 1-128 characters");
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
		throw new BadRequestError("tag name may only contain letters, digits, '.', '_', '-'");
	}
}

const MAX_ENV_TAGS = 64;
const MAX_TAG_KEY_LENGTH = 128;
const MAX_TAG_VALUE_LENGTH = 256;
const TAG_KEY_PATTERN = /^[a-zA-Z0-9._:/-]+$/;

function validateEnvTags(tags: Record<string, string>): void {
	const keys = Object.keys(tags);
	if (keys.length > MAX_ENV_TAGS) {
		throw new BadRequestError(`maximum ${MAX_ENV_TAGS} tags per environment`);
	}
	for (const key of keys) {
		if (!key || key.length > MAX_TAG_KEY_LENGTH) {
			throw new BadRequestError(`tag key must be 1-${MAX_TAG_KEY_LENGTH} characters`);
		}
		if (!TAG_KEY_PATTERN.test(key)) {
			throw new BadRequestError(
				"tag key may only contain letters, digits, '.', '_', ':', '/', '-'",
			);
		}
		const val = tags[key];
		if (typeof val !== "string" || val.length > MAX_TAG_VALUE_LENGTH) {
			throw new BadRequestError(
				`tag value must be a string up to ${MAX_TAG_VALUE_LENGTH} characters`,
			);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toYamlDiagnostics(error: string | Error): EscCliDiagnostic[] {
	const summary = error instanceof Error ? error.message : error;
	return [{ summary }];
}

function extractYamlValues(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) {
		return {};
	}
	const values = value.values;
	return isRecord(values) ? values : {};
}

function compareEnvironmentSummary(a: OrgEnvironmentSummary, b: OrgEnvironmentSummary): number {
	return (
		a.organization.localeCompare(b.organization) ||
		a.project.localeCompare(b.project) ||
		a.name.localeCompare(b.name)
	);
}

type EscEnvRow = typeof escEnvironments.$inferSelect;
type EscProjectRow = typeof escProjects.$inferSelect;
type EscRevisionRow = typeof escEnvironmentRevisions.$inferSelect;
type EscDraftRow = typeof escDrafts.$inferSelect;
type TxOrDb = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

function toEnvInfo(row: EscEnvRow): EscEnvironment {
	return {
		id: row.id,
		projectId: row.projectId,
		name: row.name,
		yamlBody: row.yamlBody,
		currentRevisionNumber: row.currentRevisionNumber,
		createdBy: row.createdBy,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function toProjectInfo(row: EscProjectRow): EscProject {
	return {
		id: row.id,
		tenantId: row.tenantId,
		name: row.name,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function toRevisionInfo(row: EscRevisionRow): EscEnvironmentRevision {
	return {
		id: row.id,
		environmentId: row.environmentId,
		revisionNumber: row.revisionNumber,
		yamlBody: row.yamlBody,
		createdBy: row.createdBy,
		createdAt: row.createdAt,
	};
}

function toDraftInfo(row: EscDraftRow): EscDraft {
	return {
		id: row.id,
		environmentId: row.environmentId,
		yamlBody: row.yamlBody,
		description: row.description,
		createdBy: row.createdBy,
		status: row.status as DraftStatus,
		appliedRevisionId: row.appliedRevisionId,
		appliedAt: row.appliedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

async function findEnvRow(
	db: TxOrDb,
	tenantId: string,
	projectName: string,
	envName: string,
): Promise<EscEnvRow | null> {
	const [row] = await db
		.select({ env: escEnvironments })
		.from(escEnvironments)
		.innerJoin(escProjects, eq(escEnvironments.projectId, escProjects.id))
		.where(
			and(
				eq(escProjects.tenantId, tenantId),
				eq(escProjects.name, projectName),
				eq(escEnvironments.name, envName),
				isNull(escEnvironments.deletedAt),
			),
		)
		.limit(1);
	return row?.env ?? null;
}

export class PostgresEscService implements EscService {
	private readonly db: Database;
	private readonly evaluator: EvaluatorClient;
	private readonly encryptionKeyHex: string;
	private readonly crypto: AesCryptoService;
	private readonly sessionTtlSeconds: number;

	constructor(deps: PostgresEscServiceDeps) {
		this.db = deps.db;
		this.evaluator = deps.evaluator;
		this.encryptionKeyHex = deps.encryptionKeyHex;
		this.crypto = new AesCryptoService(deps.encryptionKeyHex, {
			allowLegacyDecryption: deps.allowLegacyDecryption,
		});
		this.sessionTtlSeconds = deps.sessionTtlSeconds ?? 3600;
	}

	async listProjects(tenantId: string): Promise<EscProject[]> {
		const rows = await this.db
			.select()
			.from(escProjects)
			.where(eq(escProjects.tenantId, tenantId))
			.orderBy(escProjects.name);
		return rows.map(toProjectInfo);
	}

	async listAllEnvironments(
		tenantId: string,
		options: ListAllEnvironmentsOptions = {},
	): Promise<ListAllEnvironmentsResult> {
		const rows = await this.db
			.select({
				projectName: escProjects.name,
				envName: escEnvironments.name,
			})
			.from(escEnvironments)
			.innerJoin(escProjects, eq(escEnvironments.projectId, escProjects.id))
			.where(
				and(
					eq(escProjects.tenantId, tenantId),
					isNull(escEnvironments.deletedAt),
					options.projectFilter ? eq(escProjects.name, options.projectFilter) : undefined,
				),
			)
			.orderBy(escProjects.name, escEnvironments.name);

		const environments = rows
			.map(({ projectName, envName }) => ({
				organization: options.orgFilter ?? "",
				project: projectName,
				name: envName,
			}))
			.filter((env) => !options.after || `${env.project}/${env.name}` > options.after)
			.sort(compareEnvironmentSummary);

		return { environments, nextToken: "" };
	}

	async createEnvironment(
		tenantId: string,
		input: CreateEnvironmentInput,
		createdBy: string,
	): Promise<EscEnvironment> {
		validateName("project", input.projectName);
		validateName("environment", input.name);
		if (input.yamlBody !== undefined && typeof input.yamlBody !== "string") {
			throw new BadRequestError("yamlBody must be a string");
		}
		const yamlBody =
			input.yamlBody === "" || input.yamlBody === undefined ? "values: {}\n" : input.yamlBody;

		return withSpan(
			"procella.esc",
			"esc.createEnvironment",
			{ "tenant.id": tenantId, "project.name": input.projectName, "env.name": input.name },
			async () => {
				try {
					return await this.db.transaction(async (tx) => {
						await tx
							.insert(escProjects)
							.values({ tenantId, name: input.projectName })
							.onConflictDoNothing({
								target: [escProjects.tenantId, escProjects.name],
							});

						const [proj] = await tx
							.select({ id: escProjects.id })
							.from(escProjects)
							.where(
								and(eq(escProjects.tenantId, tenantId), eq(escProjects.name, input.projectName)),
							);

						if (!proj) {
							throw new Error("esc_projects row disappeared after upsert");
						}

						const [env] = await tx
							.insert(escEnvironments)
							.values({
								projectId: proj.id,
								name: input.name,
								yamlBody,
								currentRevisionNumber: 1,
								createdBy,
							})
							.returning();

						await tx.insert(escEnvironmentRevisions).values({
							environmentId: env.id,
							revisionNumber: 1,
							yamlBody,
							createdBy,
						});

						return toEnvInfo(env);
					});
				} catch (err: unknown) {
					if (pgErrorCode(err) === "23505") {
						throw new ConflictError(
							`Environment ${input.projectName}/${input.name} already exists`,
						);
					}
					throw err;
				}
			},
		);
	}

	async cloneEnvironment(
		tenantId: string,
		srcProjectName: string,
		srcEnvName: string,
		dest: CloneEnvironmentInput,
		createdBy: string,
	): Promise<EscEnvironment> {
		validateName("project", srcProjectName);
		validateName("environment", srcEnvName);
		validateName("project", dest.project);
		validateName("environment", dest.name);

		const sourceRevision =
			typeof dest.version === "number"
				? await this.getRevision(tenantId, srcProjectName, srcEnvName, dest.version)
				: await this.getEnvironment(tenantId, srcProjectName, srcEnvName);
		if (!sourceRevision) {
			throw new NotFoundError("Environment", `${srcProjectName}/${srcEnvName}`);
		}

		return this.createEnvironment(
			tenantId,
			{ projectName: dest.project, name: dest.name, yamlBody: sourceRevision.yamlBody },
			createdBy,
		);
	}

	async listEnvironments(tenantId: string, projectName: string): Promise<EscEnvironment[]> {
		validateName("project", projectName);
		const rows = await this.db
			.select({ env: escEnvironments })
			.from(escEnvironments)
			.innerJoin(escProjects, eq(escEnvironments.projectId, escProjects.id))
			.where(
				and(
					eq(escProjects.tenantId, tenantId),
					eq(escProjects.name, projectName),
					isNull(escEnvironments.deletedAt),
				),
			)
			.orderBy(escEnvironments.name);
		return rows.map((r) => toEnvInfo(r.env));
	}

	async getEnvironment(
		tenantId: string,
		projectName: string,
		envName: string,
	): Promise<EscEnvironment | null> {
		const row = await findEnvRow(this.db, tenantId, projectName, envName);
		return row ? toEnvInfo(row) : null;
	}

	async updateEnvironment(
		tenantId: string,
		projectName: string,
		envName: string,
		input: UpdateEnvironmentInput,
		updatedBy: string,
	): Promise<EscEnvironment> {
		if (typeof input.yamlBody !== "string") {
			throw new BadRequestError("yamlBody must be a string");
		}

		return withSpan(
			"procella.esc",
			"esc.updateEnvironment",
			{ "tenant.id": tenantId, "project.name": projectName, "env.name": envName },
			() =>
				this.db.transaction(async (tx) => {
					const [locked] = await tx
						.select({ env: escEnvironments })
						.from(escEnvironments)
						.innerJoin(escProjects, eq(escEnvironments.projectId, escProjects.id))
						.where(
							and(
								eq(escProjects.tenantId, tenantId),
								eq(escProjects.name, projectName),
								eq(escEnvironments.name, envName),
								isNull(escEnvironments.deletedAt),
							),
						)
						.limit(1)
						.for("update", { of: escEnvironments });

					if (!locked) {
						throw new NotFoundError("Environment", `${projectName}/${envName}`);
					}
					const row = locked.env;
					const expectedRevision = input.expectedRevisionNumber ?? row.currentRevisionNumber;
					const nextRevision = row.currentRevisionNumber + 1;
					const now = new Date();

					const [updated] = await tx
						.update(escEnvironments)
						.set({
							yamlBody: input.yamlBody,
							currentRevisionNumber: nextRevision,
							updatedAt: now,
						})
						.where(
							and(
								eq(escEnvironments.id, row.id),
								eq(escEnvironments.currentRevisionNumber, expectedRevision),
							),
						)
						.returning();

					if (!updated) {
						throw new EscPreconditionFailedError();
					}

					await tx.insert(escEnvironmentRevisions).values({
						environmentId: row.id,
						revisionNumber: nextRevision,
						yamlBody: input.yamlBody,
						createdBy: updatedBy,
					});

					return toEnvInfo(updated);
				}),
		);
	}

	async deleteEnvironment(tenantId: string, projectName: string, envName: string): Promise<void> {
		return withSpan(
			"procella.esc",
			"esc.deleteEnvironment",
			{ "tenant.id": tenantId, "project.name": projectName, "env.name": envName },
			() =>
				this.db.transaction(async (tx) => {
					const row = await findEnvRow(tx, tenantId, projectName, envName);
					if (!row) {
						throw new NotFoundError("Environment", `${projectName}/${envName}`);
					}
					const result = await tx
						.update(escEnvironments)
						.set({ deletedAt: new Date() })
						.where(and(eq(escEnvironments.id, row.id), isNull(escEnvironments.deletedAt)));
					if (result.rowCount === 0) {
						throw new NotFoundError("Environment", `${projectName}/${envName}`);
					}
				}),
		);
	}

	async listRevisions(
		tenantId: string,
		projectName: string,
		envName: string,
	): Promise<EscEnvironmentRevision[]> {
		const env = await findEnvRow(this.db, tenantId, projectName, envName);
		if (!env) {
			throw new NotFoundError("Environment", `${projectName}/${envName}`);
		}
		const rows = await this.db
			.select()
			.from(escEnvironmentRevisions)
			.where(eq(escEnvironmentRevisions.environmentId, env.id))
			.orderBy(desc(escEnvironmentRevisions.revisionNumber));
		return rows.map(toRevisionInfo);
	}

	async getRevision(
		tenantId: string,
		projectName: string,
		envName: string,
		revisionNumber: number,
	): Promise<EscEnvironmentRevision | null> {
		const env = await findEnvRow(this.db, tenantId, projectName, envName);
		if (!env) {
			return null;
		}
		const [row] = await this.db
			.select()
			.from(escEnvironmentRevisions)
			.where(
				and(
					eq(escEnvironmentRevisions.environmentId, env.id),
					eq(escEnvironmentRevisions.revisionNumber, revisionNumber),
				),
			)
			.limit(1);
		return row ? toRevisionInfo(row) : null;
	}

	async openSession(
		tenantId: string,
		projectName: string,
		envName: string,
		options?: OpenSessionOptions,
	): Promise<OpenSessionResult> {
		return withSpan(
			"procella.esc",
			"esc.openSession",
			{ "tenant.id": tenantId, "project.name": projectName, "env.name": envName },
			async () => {
				const envRow = await findEnvRow(this.db, tenantId, projectName, envName);
				if (!envRow) {
					throw new NotFoundError("Environment", `${projectName}/${envName}`);
				}

				// A draft session is recorded against the revision the draft is based on (current).
				const revisionNumber = options?.draftId
					? envRow.currentRevisionNumber
					: (options?.revision ?? envRow.currentRevisionNumber);
				const [revisionRow] = await this.db
					.select()
					.from(escEnvironmentRevisions)
					.where(
						and(
							eq(escEnvironmentRevisions.environmentId, envRow.id),
							eq(escEnvironmentRevisions.revisionNumber, revisionNumber),
						),
					)
					.limit(1);
				if (!revisionRow) {
					throw new NotFoundError(
						"EnvironmentRevision",
						`${projectName}/${envName}#${revisionNumber}`,
					);
				}

				let definition =
					revisionNumber === envRow.currentRevisionNumber ? envRow.yamlBody : revisionRow.yamlBody;
				if (options?.draftId !== undefined) {
					if (!UUID_PATTERN.test(options.draftId)) {
						throw new NotFoundError("Draft", options.draftId);
					}
					const [draftRow] = await this.db
						.select({ yamlBody: escDrafts.yamlBody })
						.from(escDrafts)
						.where(
							and(
								eq(escDrafts.id, options.draftId),
								eq(escDrafts.environmentId, envRow.id),
								eq(escDrafts.status, "open"),
							),
						)
						.limit(1);
					if (!draftRow) {
						throw new NotFoundError("Draft", options.draftId);
					}
					definition = draftRow.yamlBody;
				}

				const importRefs = extractImports(definition);
				const resolvedImports = await withSpan(
					"procella.esc",
					"esc.resolveImports",
					{ "imports.count": importRefs.length, "imports.depth": 0 },
					async () =>
						this.resolveImports(this.db, tenantId, projectName, definition, new Set<string>(), 0),
				);

				const result = await withSpan(
					"procella.esc",
					"esc.evaluator.invoke",
					{
						"env.name": envName,
						"imports.count": Object.keys(resolvedImports).length,
					},
					async () =>
						this.evaluator.evaluate({
							definition,
							imports: resolvedImports,
							encryptionKeyHex: this.encryptionKeyHex,
							tenantId,
						}),
				);

				const errorDiags = result.diagnostics.filter((d) => d.severity === "error");
				if (errorDiags.length > 0) {
					throw new EscEvaluationError(errorDiags);
				}

				const [session] = await withSpan(
					"procella.esc",
					"esc.session.store",
					{ "secrets.count": result.secrets.length },
					async () => {
						const cryptoSvc = this.crypto;
						const envFQN = `${tenantId}/${projectName}/${envName}`;
						const plaintext = new TextEncoder().encode(JSON.stringify(result.values));
						const stackInput = {
							stackId: envRow.id,
							stackFQN: envFQN,
						};
						const cipherBytes = await cryptoSvc.encrypt(stackInput, plaintext);
						const ciphertextBase64 = Buffer.from(cipherBytes).toString("base64");

						const expiresAt = new Date(Date.now() + this.sessionTtlSeconds * 1000);

						return this.db
							.insert(escSessions)
							.values({
								environmentId: envRow.id,
								revisionId: revisionRow.id,
								resolvedValuesCiphertext: ciphertextBase64,
								secretPaths: result.secrets,
								expiresAt,
							})
							.returning();
					},
				);

				return {
					sessionId: session.id,
					values: result.values,
					secrets: result.secrets,
					expiresAt: session.expiresAt,
				};
			},
		);
	}

	async getSession(
		tenantId: string,
		projectName: string,
		envName: string,
		sessionId: string,
	): Promise<OpenSessionResult | null> {
		return withSpan("procella.esc", "esc.getSession", { "session.id": sessionId }, async () => {
			const envRow = await findEnvRow(this.db, tenantId, projectName, envName);
			if (!envRow) {
				return null;
			}

			const [row] = await this.db
				.select()
				.from(escSessions)
				.where(
					and(
						eq(escSessions.id, sessionId),
						eq(escSessions.environmentId, envRow.id),
						isNull(escSessions.closedAt),
						gt(escSessions.expiresAt, new Date()),
					),
				)
				.limit(1);

			if (!row) {
				return null;
			}

			const cryptoSvc = this.crypto;
			const envFQN = `${tenantId}/${projectName}/${envName}`;
			const cipherBytes = Buffer.from(row.resolvedValuesCiphertext, "base64");
			const plainBytes = await cryptoSvc.decrypt(
				{
					stackId: envRow.id,
					stackFQN: envFQN,
				},
				new Uint8Array(cipherBytes),
			);
			const values = JSON.parse(new TextDecoder().decode(plainBytes)) as Record<string, unknown>;

			return {
				sessionId: row.id,
				values,
				secrets: row.secretPaths,
				expiresAt: row.expiresAt,
			};
		});
	}

	// ========================================================================
	// Revision tags
	// ========================================================================

	async listRevisionTags(
		tenantId: string,
		projectName: string,
		envName: string,
	): Promise<EscRevisionTag[]> {
		const env = await findEnvRow(this.db, tenantId, projectName, envName);
		if (!env) {
			throw new NotFoundError("Environment", `${projectName}/${envName}`);
		}
		const rows = await this.db
			.select({
				tag: escRevisionTags,
				revisionNumber: escEnvironmentRevisions.revisionNumber,
			})
			.from(escRevisionTags)
			.innerJoin(
				escEnvironmentRevisions,
				eq(escRevisionTags.revisionId, escEnvironmentRevisions.id),
			)
			.where(eq(escRevisionTags.environmentId, env.id))
			.orderBy(escRevisionTags.name);
		return rows.map((r) => ({
			name: r.tag.name,
			revisionNumber: r.revisionNumber,
			createdBy: r.tag.createdBy,
			createdAt: r.tag.createdAt,
		}));
	}

	async tagRevision(
		tenantId: string,
		projectName: string,
		envName: string,
		revisionNumber: number,
		tagName: string,
		createdBy: string,
	): Promise<void> {
		validateTagName(tagName);
		return withSpan(
			"procella.esc",
			"esc.tagRevision",
			{ "tenant.id": tenantId, "env.name": envName, "tag.name": tagName },
			async () => {
				const env = await findEnvRow(this.db, tenantId, projectName, envName);
				if (!env) {
					throw new NotFoundError("Environment", `${projectName}/${envName}`);
				}
				const [rev] = await this.db
					.select({ id: escEnvironmentRevisions.id })
					.from(escEnvironmentRevisions)
					.where(
						and(
							eq(escEnvironmentRevisions.environmentId, env.id),
							eq(escEnvironmentRevisions.revisionNumber, revisionNumber),
						),
					)
					.limit(1);
				if (!rev) {
					throw new NotFoundError(
						"EnvironmentRevision",
						`${projectName}/${envName}#${revisionNumber}`,
					);
				}
				await this.db
					.insert(escRevisionTags)
					.values({
						environmentId: env.id,
						revisionId: rev.id,
						name: tagName,
						createdBy,
					})
					.onConflictDoUpdate({
						target: [escRevisionTags.environmentId, escRevisionTags.name],
						set: { revisionId: rev.id, createdBy, createdAt: new Date() },
					});
			},
		);
	}

	async untagRevision(
		tenantId: string,
		projectName: string,
		envName: string,
		tagName: string,
	): Promise<void> {
		const env = await findEnvRow(this.db, tenantId, projectName, envName);
		if (!env) {
			throw new NotFoundError("Environment", `${projectName}/${envName}`);
		}
		const deleted = await this.db
			.delete(escRevisionTags)
			.where(and(eq(escRevisionTags.environmentId, env.id), eq(escRevisionTags.name, tagName)))
			.returning({ id: escRevisionTags.id });
		if (deleted.length === 0) {
			throw new NotFoundError("RevisionTag", tagName);
		}
	}

	// ========================================================================
	// Environment tags
	// ========================================================================

	async getEnvironmentTags(
		tenantId: string,
		projectName: string,
		envName: string,
	): Promise<Record<string, string>> {
		const env = await findEnvRow(this.db, tenantId, projectName, envName);
		if (!env) {
			throw new NotFoundError("Environment", `${projectName}/${envName}`);
		}
		return (env.tags ?? {}) as Record<string, string>;
	}

	async setEnvironmentTags(
		tenantId: string,
		projectName: string,
		envName: string,
		tags: Record<string, string>,
	): Promise<void> {
		validateEnvTags(tags);
		return withSpan(
			"procella.esc",
			"esc.setEnvironmentTags",
			{ "tenant.id": tenantId, "env.name": envName, "tags.count": Object.keys(tags).length },
			async () => {
				const env = await findEnvRow(this.db, tenantId, projectName, envName);
				if (!env) {
					throw new NotFoundError("Environment", `${projectName}/${envName}`);
				}
				await this.db
					.update(escEnvironments)
					.set({ tags, updatedAt: new Date() })
					.where(eq(escEnvironments.id, env.id));
			},
		);
	}

	async updateEnvironmentTags(
		tenantId: string,
		projectName: string,
		envName: string,
		patch: Record<string, string | null>,
	): Promise<void> {
		return withSpan(
			"procella.esc",
			"esc.updateEnvironmentTags",
			{ "tenant.id": tenantId, "env.name": envName },
			async () => {
				const env = await findEnvRow(this.db, tenantId, projectName, envName);
				if (!env) {
					throw new NotFoundError("Environment", `${projectName}/${envName}`);
				}
				const existing = (env.tags ?? {}) as Record<string, string>;
				const merged = { ...existing };
				for (const [k, v] of Object.entries(patch)) {
					if (v === null) {
						delete merged[k];
					} else {
						merged[k] = v;
					}
				}
				validateEnvTags(merged);
				await this.db
					.update(escEnvironments)
					.set({ tags: merged, updatedAt: new Date() })
					.where(eq(escEnvironments.id, env.id));
			},
		);
	}

	// ========================================================================
	// Drafts
	// ========================================================================

	async createDraft(
		tenantId: string,
		projectName: string,
		envName: string,
		yamlBody: string,
		description: string,
		createdBy: string,
	): Promise<EscDraft> {
		if (typeof yamlBody !== "string") {
			throw new BadRequestError("yamlBody must be a string");
		}
		return withSpan(
			"procella.esc",
			"esc.createDraft",
			{ "tenant.id": tenantId, "env.name": envName },
			async () => {
				const env = await findEnvRow(this.db, tenantId, projectName, envName);
				if (!env) {
					throw new NotFoundError("Environment", `${projectName}/${envName}`);
				}
				const [row] = await this.db
					.insert(escDrafts)
					.values({
						environmentId: env.id,
						yamlBody,
						description: description || "",
						createdBy,
					})
					.returning();
				return toDraftInfo(row);
			},
		);
	}

	async listDrafts(
		tenantId: string,
		projectName: string,
		envName: string,
		status?: DraftStatus,
	): Promise<EscDraft[]> {
		const env = await findEnvRow(this.db, tenantId, projectName, envName);
		if (!env) {
			throw new NotFoundError("Environment", `${projectName}/${envName}`);
		}
		const conditions = [eq(escDrafts.environmentId, env.id)];
		if (status) {
			conditions.push(eq(escDrafts.status, status));
		}
		const rows = await this.db
			.select()
			.from(escDrafts)
			.where(and(...conditions))
			.orderBy(desc(escDrafts.createdAt));
		return rows.map(toDraftInfo);
	}

	async updateDraft(
		tenantId: string,
		projectName: string,
		envName: string,
		draftId: string,
		yamlBody: string,
		expectedUpdatedAtMs?: number,
	): Promise<EscDraft> {
		if (typeof yamlBody !== "string") {
			throw new BadRequestError("yamlBody must be a string");
		}

		return withSpan(
			"procella.esc",
			"esc.updateDraft",
			{ "draft.id": draftId, "env.name": envName },
			() =>
				this.db.transaction(async (tx) => {
					const env = await findEnvRow(tx, tenantId, projectName, envName);
					if (!env) {
						throw new NotFoundError("Environment", `${projectName}/${envName}`);
					}
					const [draft] = await tx
						.select()
						.from(escDrafts)
						.where(and(eq(escDrafts.id, draftId), eq(escDrafts.environmentId, env.id)))
						.limit(1)
						.for("update", { of: escDrafts });
					if (!draft) {
						throw new NotFoundError("Draft", draftId);
					}
					if (draft.status !== "open") {
						throw new BadRequestError(`Draft is already ${draft.status}`);
					}
					if (
						expectedUpdatedAtMs !== undefined &&
						draft.updatedAt.getTime() !== expectedUpdatedAtMs
					) {
						throw new EscPreconditionFailedError();
					}

					const [updated] = await tx
						.update(escDrafts)
						.set({ yamlBody, updatedAt: new Date() })
						.where(and(eq(escDrafts.id, draftId), eq(escDrafts.status, "open")))
						.returning();
					if (!updated) {
						throw new ConflictError("Draft changed while updating");
					}
					return toDraftInfo(updated);
				}),
		);
	}

	async encryptSecrets(
		tenantId: string,
		projectName: string,
		envName: string,
		plaintexts: Uint8Array[],
	): Promise<string[]> {
		const env = await findEnvRow(this.db, tenantId, projectName, envName);
		if (!env) {
			throw new NotFoundError("Environment", `${projectName}/${envName}`);
		}
		return plaintexts.map((plaintext) =>
			encryptEscSecret(this.encryptionKeyHex, tenantId, plaintext),
		);
	}

	async getDraft(
		tenantId: string,
		projectName: string,
		envName: string,
		draftId: string,
	): Promise<EscDraft | null> {
		const env = await findEnvRow(this.db, tenantId, projectName, envName);
		if (!env) {
			return null;
		}
		const [row] = await this.db
			.select()
			.from(escDrafts)
			.where(and(eq(escDrafts.id, draftId), eq(escDrafts.environmentId, env.id)))
			.limit(1);
		return row ? toDraftInfo(row) : null;
	}

	async applyDraft(
		tenantId: string,
		projectName: string,
		envName: string,
		draftId: string,
		appliedBy: string,
	): Promise<EscDraft> {
		return withSpan(
			"procella.esc",
			"esc.applyDraft",
			{ "tenant.id": tenantId, "env.name": envName, "draft.id": draftId },
			() =>
				this.db.transaction(async (tx) => {
					const [locked] = await tx
						.select({ env: escEnvironments })
						.from(escEnvironments)
						.innerJoin(escProjects, eq(escEnvironments.projectId, escProjects.id))
						.where(
							and(
								eq(escProjects.tenantId, tenantId),
								eq(escProjects.name, projectName),
								eq(escEnvironments.name, envName),
								isNull(escEnvironments.deletedAt),
							),
						)
						.limit(1)
						.for("update", { of: escEnvironments });

					if (!locked) {
						throw new NotFoundError("Environment", `${projectName}/${envName}`);
					}
					const envRow = locked.env;

					const [draft] = await tx
						.select()
						.from(escDrafts)
						.where(and(eq(escDrafts.id, draftId), eq(escDrafts.environmentId, envRow.id)))
						.limit(1)
						.for("update", { of: escDrafts });

					if (!draft) {
						throw new NotFoundError("Draft", draftId);
					}
					if (draft.status !== "open") {
						throw new BadRequestError(`Draft is already ${draft.status}`);
					}

					const nextRevision = envRow.currentRevisionNumber + 1;
					const now = new Date();

					await tx
						.update(escEnvironments)
						.set({
							yamlBody: draft.yamlBody,
							currentRevisionNumber: nextRevision,
							updatedAt: now,
						})
						.where(eq(escEnvironments.id, envRow.id));

					const [rev] = await tx
						.insert(escEnvironmentRevisions)
						.values({
							environmentId: envRow.id,
							revisionNumber: nextRevision,
							yamlBody: draft.yamlBody,
							createdBy: appliedBy,
						})
						.returning();

					const [updated] = await tx
						.update(escDrafts)
						.set({
							status: "applied",
							appliedRevisionId: rev.id,
							appliedAt: now,
							updatedAt: now,
						})
						.where(and(eq(escDrafts.id, draftId), eq(escDrafts.status, "open")))
						.returning();

					if (!updated) {
						throw new ConflictError("Draft changed while applying");
					}

					return toDraftInfo(updated);
				}),
		);
	}

	async discardDraft(
		tenantId: string,
		projectName: string,
		envName: string,
		draftId: string,
	): Promise<void> {
		return withSpan(
			"procella.esc",
			"esc.discardDraft",
			{ "tenant.id": tenantId, "env.name": envName, "draft.id": draftId },
			() =>
				this.db.transaction(async (tx) => {
					const env = await findEnvRow(tx, tenantId, projectName, envName);
					if (!env) {
						throw new NotFoundError("Environment", `${projectName}/${envName}`);
					}
					const [draft] = await tx
						.select()
						.from(escDrafts)
						.where(and(eq(escDrafts.id, draftId), eq(escDrafts.environmentId, env.id)))
						.limit(1)
						.for("update", { of: escDrafts });
					if (!draft) {
						throw new NotFoundError("Draft", draftId);
					}
					if (draft.status !== "open") {
						throw new BadRequestError(`Draft is already ${draft.status}`);
					}
					const [updated] = await tx
						.update(escDrafts)
						.set({ status: "discarded", updatedAt: new Date() })
						.where(and(eq(escDrafts.id, draftId), eq(escDrafts.status, "open")))
						.returning({ id: escDrafts.id });
					if (!updated) {
						throw new ConflictError("Draft changed while discarding");
					}
				}),
		);
	}

	async validateYaml(yamlBody: string): Promise<ValidateYamlResult> {
		if (typeof yamlBody !== "string") {
			throw new BadRequestError("yamlBody must be a string");
		}

		const doc = parseDocument(yamlBody, { prettyErrors: false, uniqueKeys: false });
		if (doc.errors.length > 0) {
			return {
				values: {},
				diagnostics: doc.errors.flatMap((error) => toYamlDiagnostics(error)),
			};
		}

		const parsed = doc.toJS();
		return {
			values: extractYamlValues(parsed),
			diagnostics: [],
		};
	}

	async gcSweep(): Promise<{ closedCount: number }> {
		return escGcSweep(this.db);
	}

	private async resolveImports(
		db: TxOrDb,
		tenantId: string,
		contextProjectName: string,
		yamlBody: string,
		visited: Set<string>,
		depth: number,
	): Promise<Record<string, string>> {
		if (depth > MAX_IMPORT_DEPTH) {
			throw new BadRequestError(
				`import_too_deep: exceeded maximum import depth of ${MAX_IMPORT_DEPTH}`,
			);
		}

		const importRefs = extractImports(yamlBody);
		if (importRefs.length === 0) return {};

		const result: Record<string, string> = {};

		await Promise.all(
			importRefs.map(async (ref) => {
				let importProject: string;
				let importEnv: string;
				if (ref.includes("/")) {
					const slashIdx = ref.indexOf("/");
					importProject = ref.slice(0, slashIdx);
					importEnv = ref.slice(slashIdx + 1);
				} else {
					importProject = contextProjectName;
					importEnv = ref;
				}

				const fqn = `${importProject}/${importEnv}`;
				if (visited.has(fqn)) {
					throw new BadRequestError(
						`import_cycle: circular import detected: ${[...visited, fqn].join(" → ")}`,
					);
				}

				const importedRow = await findEnvRow(db, tenantId, importProject, importEnv);
				if (!importedRow) {
					throw new NotFoundError("ImportedEnvironment", fqn);
				}

				const childVisited = new Set(visited);
				childVisited.add(fqn);

				const childImports = await this.resolveImports(
					db,
					tenantId,
					importProject,
					importedRow.yamlBody,
					childVisited,
					depth + 1,
				);

				Object.assign(result, childImports);
				result[fqn] = importedRow.yamlBody;
			}),
		);

		return result;
	}
}

// ============================================================================
// ESC Session GC — standalone function for use by cron lambdas
// ============================================================================

/** Advisory lock ID for ESC session GC (ASCII "ESCG_ESC"). Distinct from updates GC lock. */
const ESC_GC_ADVISORY_LOCK_ID: bigint = BigInt("0x455343475f455343");

/**
 * Sweep expired ESC sessions. Uses pg_try_advisory_lock for cluster safety.
 * Soft-closes (sets closed_at) up to 1000 expired sessions per sweep.
 * Returns { closedCount: 0 } if lock not acquired (another replica handles it).
 */
export async function escGcSweep(db: Database): Promise<{ closedCount: number }> {
	const lockId = ESC_GC_ADVISORY_LOCK_ID.toString();
	return withSpan("procella.esc", "esc.gc.sweep", {}, async () => {
		return await db.transaction(async (tx) => {
			const lockResult = await tx.execute(
				sql`SELECT pg_try_advisory_xact_lock(${lockId}::bigint) as acquired`,
			);
			const rows = "rows" in lockResult ? lockResult.rows : lockResult;
			const acquired = (rows[0] as { acquired?: boolean })?.acquired;
			if (!acquired) {
				return { closedCount: 0 };
			}

			const expired = await tx
				.select({ id: escSessions.id })
				.from(escSessions)
				.where(and(lt(escSessions.expiresAt, sql`now()`), isNull(escSessions.closedAt)))
				.limit(1000);

			if (expired.length === 0) {
				return { closedCount: 0 };
			}

			const ids = expired.map((s) => s.id);
			await tx
				.update(escSessions)
				.set({ closedAt: sql`now()` })
				.where(inArray(escSessions.id, ids));

			return { closedCount: ids.length };
		});
	});
}

export type {
	EvaluateDiagnostic,
	EvaluatePayload,
	EvaluateResult,
	EvaluatorClient,
} from "./evaluator-client.js";
