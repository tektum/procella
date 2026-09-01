import type { AuthService } from "@procella/auth";
import type {
	CloneEnvironmentInput,
	CreateEnvironmentInput,
	DraftStatus,
	EscCliDiagnostic,
	EscService,
	UpdateEnvironmentInput,
} from "@procella/esc";
import { EscEvaluationError } from "@procella/esc";
import { BadRequestError, NotFoundError } from "@procella/types";
import type { Context } from "hono";
import { z } from "zod/v4";
import type { Env } from "../types.js";
import { param } from "./params.js";

const yamlBodySchema = z.object({ yamlBody: z.string() });
const envTagsSchema = z.record(z.string(), z.string());
const envTagsPatchSchema = z.record(z.string(), z.string().nullable());
const draftCreateSchema = z.object({
	yamlBody: z.string(),
	description: z.string().optional().default(""),
});
const draftStatusSchema = z.enum(["open", "applied", "discarded"]);
const publicCreateEnvironmentSchema = z.object({
	project: z.string().min(1),
	name: z.string().min(1),
});
const cloneEnvironmentSchema = z.object({
	project: z.string().min(1),
	name: z.string().min(1),
	version: z.number().int().positive().optional(),
	preserveHistory: z.boolean().optional(),
	preserveAccess: z.boolean().optional(),
	preserveEnvironmentTags: z.boolean().optional(),
	preserveRevisionTags: z.boolean().optional(),
});
const revisionTagCreateSchema = z.object({
	name: z.string().min(1),
	revision: z.number().int().positive().optional(),
});
const revisionTagUpdateSchema = z.object({
	revision: z.number().int().positive().optional(),
});

const revisionHeader = "Pulumi-ESC-Revision";
const UNKNOWN_USER = "Unknown user";
const MAX_CONCURRENT_IDENTITY_LOOKUPS = 8;

type UserDisplayNameResolver = AuthService["resolveUserDisplayName"];

async function resolveCreatedBy<T extends { createdBy: string }>(
	resolveUserDisplayName: UserDisplayNameResolver,
	value: T,
): Promise<T> {
	const createdBy =
		(await resolveUserDisplayName(value.createdBy).catch(() => null)) ?? UNKNOWN_USER;
	return { ...value, createdBy };
}

async function resolveCreatedByList<T extends { createdBy: string }>(
	resolveUserDisplayName: UserDisplayNameResolver,
	values: T[],
): Promise<T[]> {
	const subjects = [...new Set(values.map((value) => value.createdBy))];
	const displayNames = new Map<string, string>();
	let nextSubject = 0;
	const worker = async () => {
		while (nextSubject < subjects.length) {
			const subject = subjects[nextSubject++];
			if (subject === undefined) return;
			const displayName = (await resolveUserDisplayName(subject).catch(() => null)) ?? UNKNOWN_USER;
			displayNames.set(subject, displayName);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(MAX_CONCURRENT_IDENTITY_LOOKUPS, subjects.length) }, worker),
	);
	return values.map((value) => ({
		...value,
		createdBy: displayNames.get(value.createdBy) ?? UNKNOWN_USER,
	}));
}

type EscValueJson = {
	value?: unknown;
	secret?: boolean;
	unknown?: boolean;
	trace?: Record<string, unknown>;
};

function formatEnvironmentEtag(revisionNumber: number): string {
	return `W/"r${revisionNumber}"`;
}

function formatDraftEtag(updatedAt: Date | string): string {
	const time = new Date(updatedAt).getTime();
	return `W/"d${time}"`;
}

function normalizeTag(header: string | undefined): string | null {
	return header?.trim() || null;
}

function toCliDiagnostics(
	diagnostics: Array<EscCliDiagnostic | { summary: string; detail?: string }>,
) {
	return diagnostics.map((diagnostic) => ({
		summary: diagnostic.summary,
		...(diagnostic.detail ? { detail: diagnostic.detail } : {}),
	}));
}

function encodeEscValue(value: unknown, path: string, secretPaths: Set<string>): EscValueJson {
	const secret = path !== "" && secretPaths.has(path);

	if (Array.isArray(value)) {
		return {
			value: value.map((item, index) => encodeEscValue(item, `${path}[${index}]`, secretPaths)),
			...(secret ? { secret: true } : {}),
			trace: {},
		};
	}

	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>);
		return {
			value: Object.fromEntries(
				entries.map(([key, item]) => [
					key,
					encodeEscValue(item, path ? `${path}.${key}` : key, secretPaths),
				]),
			),
			...(secret ? { secret: true } : {}),
			trace: {},
		};
	}

	return {
		...(value === undefined ? {} : { value }),
		...(secret ? { secret: true } : {}),
		trace: {},
	};
}

function toEscEnvironment(values: Record<string, unknown>, secretPaths: string[] = []) {
	const secrets = new Set(secretPaths);
	return {
		properties: Object.fromEntries(
			Object.entries(values).map(([key, value]) => [key, encodeEscValue(value, key, secrets)]),
		),
	};
}

function parseRevisionValue(version: string): number {
	const revisionNumber = Number.parseInt(version, 10);
	if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
		throw new BadRequestError("version must be a positive integer");
	}
	return revisionNumber;
}

export function escHandlers(deps: {
	esc: EscService;
	resolveUserDisplayName: UserDisplayNameResolver;
}) {
	const requireOrgMatch = (c: Context<Env>): string => {
		const caller = c.get("caller");
		const org = param(c, "org");
		if (org !== caller.orgSlug) {
			throw new BadRequestError("Organization does not match caller organization");
		}
		return caller.tenantId;
	};

	const resolveEnvironmentRevision = async (
		tenantId: string,
		projectName: string,
		envName: string,
		version?: string,
	) => {
		if (!version || version === "latest") {
			const env = await deps.esc.getEnvironment(tenantId, projectName, envName);
			if (!env) {
				throw new NotFoundError("Environment", `${projectName}/${envName}`);
			}
			return {
				yamlBody: env.yamlBody,
				revisionNumber: env.currentRevisionNumber,
			};
		}

		if (/^\d+$/.test(version)) {
			const revision = await deps.esc.getRevision(
				tenantId,
				projectName,
				envName,
				parseRevisionValue(version),
			);
			if (!revision) {
				throw new NotFoundError("EnvironmentRevision", `${projectName}/${envName}#${version}`);
			}
			return {
				yamlBody: revision.yamlBody,
				revisionNumber: revision.revisionNumber,
			};
		}

		const tag = (await deps.esc.listRevisionTags(tenantId, projectName, envName)).find(
			(candidate) => candidate.name === version,
		);
		if (!tag) {
			throw new NotFoundError("RevisionTag", version);
		}
		const revision = await deps.esc.getRevision(tenantId, projectName, envName, tag.revisionNumber);
		if (!revision) {
			throw new NotFoundError(
				"EnvironmentRevision",
				`${projectName}/${envName}#${tag.revisionNumber}`,
			);
		}
		return {
			yamlBody: revision.yamlBody,
			revisionNumber: revision.revisionNumber,
		};
	};

	const mapPublicEscError = (error: unknown) => {
		if (error instanceof EscEvaluationError) {
			return {
				diagnostics: error.diagnostics.map((diagnostic) => ({ summary: diagnostic.summary })),
			};
		}
		throw error;
	};

	return {
		// ---------------------------------------------------------------------
		// Public ESC CLI contract (/api/esc/environments/*)
		// ---------------------------------------------------------------------
		listAllEnvironments: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const orgFilter = c.req.query("orgFilter");
			if (orgFilter && orgFilter !== caller.orgSlug) {
				return c.json({ environments: [], nextToken: "" });
			}
			const result = await deps.esc.listAllEnvironments(caller.tenantId, {
				orgFilter: caller.orgSlug,
				projectFilter: c.req.query("projectFilter") ?? undefined,
				after: c.req.query("continuationToken") ?? undefined,
			});
			return c.json(result);
		},

		listOrgEnvironments: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const result = await deps.esc.listAllEnvironments(tenantId, {
				orgFilter: param(c, "org"),
				projectFilter: c.req.query("projectFilter") ?? undefined,
				after: c.req.query("continuationToken") ?? undefined,
			});
			return c.json(result);
		},

		createEnvironment: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const caller = c.get("caller");
			const body = publicCreateEnvironmentSchema.parse(await c.req.json().catch(() => ({})));
			const input: CreateEnvironmentInput = {
				projectName: body.project,
				name: body.name,
				yamlBody: "",
			};
			await deps.esc.createEnvironment(tenantId, input, caller.userId);
			return c.body(null, 201);
		},

		cloneEnvironment: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const caller = c.get("caller");
			const srcProjectName = param(c, "project");
			const srcEnvName = param(c, "envName");
			const dest = cloneEnvironmentSchema.parse(await c.req.json().catch(() => ({})));
			await deps.esc.cloneEnvironment(
				tenantId,
				srcProjectName,
				srcEnvName,
				dest satisfies CloneEnvironmentInput,
				caller.userId,
			);
			return c.body(null, 201);
		},

		getEnvironment: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const version = c.req.param("version");
			const resolved = await resolveEnvironmentRevision(tenantId, projectName, envName, version);
			return c.newResponse(resolved.yamlBody, {
				status: 200,
				headers: {
					"Content-Type": "text/x-yaml; charset=utf-8",
					ETag: formatEnvironmentEtag(resolved.revisionNumber),
					[revisionHeader]: String(resolved.revisionNumber),
				},
			});
		},

		updateEnvironment: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const caller = c.get("caller");
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const providedTag = normalizeTag(c.req.header("If-Match") ?? c.req.header("ETag"));

			const env = await deps.esc.getEnvironment(tenantId, projectName, envName);
			if (!env) {
				throw new NotFoundError("Environment", `${projectName}/${envName}`);
			}
			if (providedTag && providedTag !== formatEnvironmentEtag(env.currentRevisionNumber)) {
				return c.json({ code: 412, message: "Precondition Failed" }, 412);
			}

			const yamlBody = await c.req.text();
			const validation = await deps.esc.validateYaml(yamlBody);
			if (validation.diagnostics.length > 0) {
				return c.json(
					{
						code: 400,
						message: "Invalid environment definition",
						diagnostics: toCliDiagnostics(validation.diagnostics),
					},
					400,
				);
			}

			const updated = await deps.esc.updateEnvironment(
				tenantId,
				projectName,
				envName,
				{ yamlBody } satisfies UpdateEnvironmentInput,
				caller.userId,
			);
			return c.newResponse(null, {
				status: 200,
				headers: {
					ETag: formatEnvironmentEtag(updated.currentRevisionNumber),
					[revisionHeader]: String(updated.currentRevisionNumber),
				},
			});
		},

		deleteEnvironment: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			await deps.esc.deleteEnvironment(tenantId, param(c, "project"), param(c, "envName"));
			return c.body(null, 204);
		},

		listRevisions: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const revisions = await deps.esc.listRevisions(tenantId, projectName, envName);
			const tags = await deps.esc.listRevisionTags(tenantId, projectName, envName);
			const tagsByRevision = new Map<number, string[]>();
			for (const tag of tags) {
				const bucket = tagsByRevision.get(tag.revisionNumber) ?? [];
				bucket.push(tag.name);
				tagsByRevision.set(tag.revisionNumber, bucket);
			}
			const count = c.req.query("count");
			const limit = count ? parseRevisionValue(count) : undefined;
			const resolvedRevisions = await resolveCreatedByList(
				deps.resolveUserDisplayName,
				revisions.slice(0, limit),
			);
			return c.json(
				resolvedRevisions.map((revision) => ({
					number: revision.revisionNumber,
					created: revision.createdAt,
					creatorLogin: revision.createdBy,
					creatorName: revision.createdBy,
					tags: tagsByRevision.get(revision.revisionNumber) ?? [],
				})),
			);
		},

		listRevisionTags: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const tags = await deps.esc.listRevisionTags(
				tenantId,
				param(c, "project"),
				param(c, "envName"),
			);
			const resolvedTags = await resolveCreatedByList(deps.resolveUserDisplayName, tags);
			return c.json({
				tags: resolvedTags.map((tag) => ({
					name: tag.name,
					revision: tag.revisionNumber,
					created: tag.createdAt,
					modified: tag.createdAt,
					editorLogin: tag.createdBy,
					editorName: tag.createdBy,
				})),
				nextToken: "",
			});
		},

		createRevisionTag: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const caller = c.get("caller");
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const body = revisionTagCreateSchema.parse(await c.req.json().catch(() => ({})));
			const env = await deps.esc.getEnvironment(tenantId, projectName, envName);
			if (!env) {
				throw new NotFoundError("Environment", `${projectName}/${envName}`);
			}
			await deps.esc.tagRevision(
				tenantId,
				projectName,
				envName,
				body.revision ?? env.currentRevisionNumber,
				body.name,
				caller.userId,
			);
			return c.body(null, 201);
		},

		getRevisionTag: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const tagName = param(c, "tagName");
			const tag = (await deps.esc.listRevisionTags(tenantId, projectName, envName)).find(
				(candidate) => candidate.name === tagName,
			);
			if (!tag) {
				throw new NotFoundError("RevisionTag", tagName);
			}
			const createdBy =
				(await deps.resolveUserDisplayName(tag.createdBy).catch(() => null)) ?? UNKNOWN_USER;
			return c.json({
				name: tag.name,
				revision: tag.revisionNumber,
				created: tag.createdAt,
				modified: tag.createdAt,
				editorLogin: createdBy,
				editorName: createdBy,
			});
		},

		updateRevisionTag: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const caller = c.get("caller");
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const tagName = param(c, "tagName");
			const body = revisionTagUpdateSchema.parse(await c.req.json().catch(() => ({})));
			const env = await deps.esc.getEnvironment(tenantId, projectName, envName);
			if (!env) {
				throw new NotFoundError("Environment", `${projectName}/${envName}`);
			}
			await deps.esc.tagRevision(
				tenantId,
				projectName,
				envName,
				body.revision ?? env.currentRevisionNumber,
				tagName,
				caller.userId,
			);
			return c.body(null, 200);
		},

		deleteRevisionTag: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			await deps.esc.untagRevision(
				tenantId,
				param(c, "project"),
				param(c, "envName"),
				param(c, "tagName"),
			);
			return c.body(null, 204);
		},

		validateYaml: async (c: Context<Env>) => {
			requireOrgMatch(c);
			const yamlBody = await c.req.text();
			const validation = await deps.esc.validateYaml(yamlBody);
			if (validation.diagnostics.length > 0) {
				return c.json(
					{
						code: 400,
						message: "Invalid environment definition",
						diagnostics: toCliDiagnostics(validation.diagnostics),
					},
					400,
				);
			}
			return c.json(toEscEnvironment(validation.values));
		},

		openSession: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			try {
				const result = await deps.esc.openSession(
					tenantId,
					param(c, "project"),
					param(c, "envName"),
				);
				return c.json({ id: result.sessionId });
			} catch (error) {
				const mapped = mapPublicEscError(error);
				if ("diagnostics" in mapped) {
					return c.json(
						{
							code: 400,
							message: "Invalid environment definition",
							diagnostics: mapped.diagnostics,
						},
						400,
					);
				}
				throw error;
			}
		},

		getSession: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const result = await deps.esc.getSession(
				tenantId,
				param(c, "project"),
				param(c, "envName"),
				param(c, "sessionId"),
			);
			if (!result) {
				throw new NotFoundError("EscSession", param(c, "sessionId"));
			}
			return c.json(toEscEnvironment(result.values, result.secrets));
		},

		createDraft: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const caller = c.get("caller");
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const env = await deps.esc.getEnvironment(tenantId, projectName, envName);
			if (!env) {
				throw new NotFoundError("Environment", `${projectName}/${envName}`);
			}
			const providedTag = normalizeTag(c.req.header("ETag"));
			if (providedTag && providedTag !== formatEnvironmentEtag(env.currentRevisionNumber)) {
				return c.json({ code: 412, message: "Precondition Failed" }, 412);
			}
			const yamlBody = await c.req.text();
			const validation = await deps.esc.validateYaml(yamlBody);
			if (validation.diagnostics.length > 0) {
				return c.json(
					{
						code: 400,
						message: "Invalid environment definition",
						diagnostics: toCliDiagnostics(validation.diagnostics),
					},
					400,
				);
			}
			const draft = await deps.esc.createDraft(
				tenantId,
				projectName,
				envName,
				yamlBody,
				"",
				caller.userId,
			);
			return c.json(
				{ changeRequestId: draft.id, latestRevisionNumber: env.currentRevisionNumber },
				201,
			);
		},

		getDraft: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const draftId = param(c, "draftId");
			const draft = await deps.esc.getDraft(tenantId, projectName, envName, draftId);
			if (!draft) {
				throw new NotFoundError("Draft", draftId);
			}
			return c.newResponse(draft.yamlBody, {
				status: 200,
				headers: {
					"Content-Type": "text/x-yaml; charset=utf-8",
					ETag: formatDraftEtag(draft.updatedAt),
				},
			});
		},

		updateDraft: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const draftId = param(c, "draftId");
			const draft = await deps.esc.getDraft(tenantId, projectName, envName, draftId);
			if (!draft) {
				throw new NotFoundError("Draft", draftId);
			}
			const providedTag = normalizeTag(c.req.header("If-Match"));
			if (providedTag && providedTag !== formatDraftEtag(draft.updatedAt)) {
				return c.json({ code: 412, message: "Precondition Failed" }, 412);
			}
			const yamlBody = await c.req.text();
			const validation = await deps.esc.validateYaml(yamlBody);
			if (validation.diagnostics.length > 0) {
				return c.json(
					{
						code: 400,
						message: "Invalid environment definition",
						diagnostics: toCliDiagnostics(validation.diagnostics),
					},
					400,
				);
			}
			const updated = await deps.esc.updateDraft(tenantId, projectName, envName, draftId, yamlBody);
			const env = await deps.esc.getEnvironment(tenantId, projectName, envName);
			if (!env) {
				throw new NotFoundError("Environment", `${projectName}/${envName}`);
			}
			return c.json({
				changeRequestId: updated.id,
				latestRevisionNumber: env.currentRevisionNumber,
			});
		},

		// ---------------------------------------------------------------------
		// Internal dashboard contract (/api/esc/v1-internal/*)
		// ---------------------------------------------------------------------
		internalCreateEnvironment: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const caller = c.get("caller");
			const projectName = param(c, "project");
			const body = await c.req.json().catch(() => ({}));
			const schema = z.object({ name: z.string().min(1), yamlBody: z.string() });
			const parsed = schema.parse(body);
			const input: CreateEnvironmentInput = {
				projectName,
				name: parsed.name,
				yamlBody: parsed.yamlBody,
			};
			const env = await deps.esc.createEnvironment(tenantId, input, caller.userId);
			return c.json(await resolveCreatedBy(deps.resolveUserDisplayName, env), 201);
		},

		internalListEnvironments: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envs = await deps.esc.listEnvironments(tenantId, projectName);
			return c.json({
				environments: await resolveCreatedByList(deps.resolveUserDisplayName, envs),
			});
		},

		internalGetEnvironment: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const env = await deps.esc.getEnvironment(tenantId, projectName, envName);
			if (!env) {
				throw new NotFoundError("Environment", `${projectName}/${envName}`);
			}
			return c.json(await resolveCreatedBy(deps.resolveUserDisplayName, env));
		},

		internalUpdateEnvironment: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const caller = c.get("caller");
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const body = await c.req.json().catch(() => ({}));
			const parsed = yamlBodySchema.parse(body);
			const env = await deps.esc.updateEnvironment(
				tenantId,
				projectName,
				envName,
				{ yamlBody: parsed.yamlBody },
				caller.userId,
			);
			return c.json(await resolveCreatedBy(deps.resolveUserDisplayName, env));
		},

		internalDeleteEnvironment: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			await deps.esc.deleteEnvironment(tenantId, param(c, "project"), param(c, "envName"));
			return c.body(null, 204);
		},

		internalListRevisions: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const revisions = await deps.esc.listRevisions(
				tenantId,
				param(c, "project"),
				param(c, "envName"),
			);
			return c.json({
				revisions: await resolveCreatedByList(deps.resolveUserDisplayName, revisions),
			});
		},

		internalGetRevision: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const versionStr = param(c, "version");
			const rev = await deps.esc.getRevision(
				tenantId,
				projectName,
				envName,
				parseRevisionValue(versionStr),
			);
			if (!rev) {
				throw new NotFoundError("EnvironmentRevision", `${projectName}/${envName}#${versionStr}`);
			}
			return c.json(await resolveCreatedBy(deps.resolveUserDisplayName, rev));
		},

		internalOpenSession: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const result = await deps.esc.openSession(tenantId, param(c, "project"), param(c, "envName"));
			return c.json(result, 201);
		},

		internalGetSession: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const result = await deps.esc.getSession(
				tenantId,
				param(c, "project"),
				param(c, "envName"),
				param(c, "sessionId"),
			);
			if (!result) {
				throw new NotFoundError("EscSession", param(c, "sessionId"));
			}
			return c.json(result);
		},

		internalListRevisionTags: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const tags = await deps.esc.listRevisionTags(
				tenantId,
				param(c, "project"),
				param(c, "envName"),
			);
			return c.json({ tags: await resolveCreatedByList(deps.resolveUserDisplayName, tags) });
		},

		internalTagRevision: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const caller = c.get("caller");
			await deps.esc.tagRevision(
				tenantId,
				param(c, "project"),
				param(c, "envName"),
				parseRevisionValue(param(c, "version")),
				param(c, "tagName"),
				caller.userId,
			);
			return c.body(null, 204);
		},

		internalUntagRevision: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			await deps.esc.untagRevision(
				tenantId,
				param(c, "project"),
				param(c, "envName"),
				param(c, "tagName"),
			);
			return c.body(null, 204);
		},

		getEnvironmentTags: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const tags = await deps.esc.getEnvironmentTags(
				tenantId,
				param(c, "project"),
				param(c, "envName"),
			);
			return c.json({ tags });
		},

		setEnvironmentTags: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				throw new BadRequestError(
					"PUT /tags requires a JSON object body. Send {} to clear all tags explicitly.",
				);
			}
			await deps.esc.setEnvironmentTags(tenantId, projectName, envName, envTagsSchema.parse(body));
			return c.body(null, 204);
		},

		updateEnvironmentTags: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			await deps.esc.updateEnvironmentTags(
				tenantId,
				param(c, "project"),
				param(c, "envName"),
				envTagsPatchSchema.parse(await c.req.json().catch(() => ({}))),
			);
			return c.body(null, 204);
		},

		internalCreateDraft: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const caller = c.get("caller");
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const parsed = draftCreateSchema.parse(await c.req.json().catch(() => ({})));
			const draft = await deps.esc.createDraft(
				tenantId,
				projectName,
				envName,
				parsed.yamlBody,
				parsed.description,
				caller.userId,
			);
			return c.json(await resolveCreatedBy(deps.resolveUserDisplayName, draft), 201);
		},

		internalListDrafts: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const rawStatus = c.req.query("status");
			let status: DraftStatus | undefined;
			if (rawStatus !== undefined) {
				const parsed = draftStatusSchema.safeParse(rawStatus);
				if (!parsed.success) {
					throw new BadRequestError("status must be one of: open, applied, discarded");
				}
				status = parsed.data;
			}
			const drafts = await deps.esc.listDrafts(
				tenantId,
				param(c, "project"),
				param(c, "envName"),
				status,
			);
			return c.json({ drafts: await resolveCreatedByList(deps.resolveUserDisplayName, drafts) });
		},

		internalGetDraft: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const draft = await deps.esc.getDraft(
				tenantId,
				param(c, "project"),
				param(c, "envName"),
				param(c, "draftId"),
			);
			if (!draft) {
				throw new NotFoundError("Draft", param(c, "draftId"));
			}
			return c.json(await resolveCreatedBy(deps.resolveUserDisplayName, draft));
		},

		applyDraft: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const caller = c.get("caller");
			const draft = await deps.esc.applyDraft(
				tenantId,
				param(c, "project"),
				param(c, "envName"),
				param(c, "draftId"),
				caller.userId,
			);
			return c.json(await resolveCreatedBy(deps.resolveUserDisplayName, draft));
		},

		discardDraft: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			await deps.esc.discardDraft(
				tenantId,
				param(c, "project"),
				param(c, "envName"),
				param(c, "draftId"),
			);
			return c.body(null, 204);
		},
	};
}
