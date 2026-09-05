// @procella/db — Drizzle ORM schema definitions for Procella's PostgreSQL database.
//
// This is a multi-tenant SaaS. Auth is Descope (no users/orgs tables).
// tenant_id is TEXT from Descope JWT — never a FK, always a soft reference.
// Cross-domain references (stack_id in updates) are soft references (no FK).

import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

// ============================================================================
// projects — Tenant-scoped project registry
// ============================================================================

export const projects = pgTable(
	"projects",
	{
		id: uuid().primaryKey().defaultRandom(),
		tenantId: text("tenant_id").notNull(),
		name: text().notNull(),
		description: text(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [uniqueIndex("idx_projects_tenant_name").on(table.tenantId, table.name)],
);

// ============================================================================
// stacks — Stack registry within projects
// ============================================================================

export const stacks = pgTable(
	"stacks",
	{
		id: uuid().primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text().notNull(),
		tags: jsonb().notNull().default({}),
		searchVector: text("search_vector"),
		activeUpdateId: uuid("active_update_id"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [uniqueIndex("idx_stacks_project_name").on(table.projectId, table.name)],
);

// ============================================================================
// updates — Update lifecycle tracking
// ============================================================================

export const updates = pgTable(
	"updates",
	{
		id: uuid().primaryKey().defaultRandom(),
		stackId: uuid("stack_id").notNull(),
		kind: text().notNull(),
		status: text().notNull().default("not started"),
		result: text(),
		message: text(),
		version: integer().notNull().default(1),
		leaseToken: text("lease_token"),
		leaseExpiresAt: timestamp("lease_expires_at"),
		startedAt: timestamp("started_at"),
		completedAt: timestamp("completed_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
		config: jsonb(),
		program: jsonb(),
		environment: jsonb().$type<Record<string, string>>().notNull().default({}),
		initiatedBy: text("initiated_by"),
		initiatedByType: text("initiated_by_type"),
		initiatedByDisplay: text("initiated_by_display"),
		initiatedByMeta: jsonb("initiated_by_meta").$type<Record<string, unknown>>(),
		githubTarget: jsonb("github_target").$type<{
			tenantId: string;
			owner: string;
			repo: string;
			prNumber: number;
			sha: string;
			org: string;
			project: string;
			stack: string;
		}>(),
		githubCommentId: text("github_comment_id"),
		summarySequence: integer("summary_sequence"),
		summary: jsonb().$type<Record<string, unknown>>(),
	},
	(table) => [
		check(
			"chk_updates_kind",
			sql`${table.kind} IN ('update', 'preview', 'refresh', 'destroy', 'import')`,
		),
		uniqueIndex("idx_updates_active")
			.on(table.stackId)
			.where(sql`status IN ('not started', 'requested', 'running')`),
		uniqueIndex("idx_updates_stack_version")
			.on(table.stackId, table.version)
			.where(sql`${table.kind} <> 'preview'`),
	],
);

// ============================================================================
// checkpoints — State snapshots
// ============================================================================

export const checkpoints = pgTable(
	"checkpoints",
	{
		id: uuid().primaryKey().defaultRandom(),
		updateId: uuid("update_id")
			.notNull()
			.references(() => updates.id, { onDelete: "cascade" }),
		stackId: uuid("stack_id").notNull(),
		version: integer().notNull(),
		data: jsonb(),
		blobKey: text("blob_key"),
		isDelta: boolean("is_delta").notNull().default(false),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => [uniqueIndex("idx_checkpoints_update_version").on(table.updateId, table.version)],
);

// ============================================================================
// update_events — Engine events during updates
// ============================================================================

export const updateEvents = pgTable(
	"update_events",
	{
		id: uuid().primaryKey().defaultRandom(),
		updateId: uuid("update_id")
			.notNull()
			.references(() => updates.id, { onDelete: "cascade" }),
		sequence: integer().notNull(),
		kind: text().notNull(),
		fields: jsonb().notNull().default({}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => [uniqueIndex("idx_update_events_update_sequence").on(table.updateId, table.sequence)],
);

// ============================================================================
// github_update_outbox — Transactional GitHub update publication queue
// ============================================================================

export const githubUpdateOutbox = pgTable(
	"github_update_outbox",
	{
		id: uuid().primaryKey().defaultRandom(),
		updateId: uuid("update_id")
			.notNull()
			.references(() => updates.id, { onDelete: "cascade" }),
		phase: text().$type<"started" | "terminal">().notNull(),
		revision: integer().notNull().default(1),
		deliveredRevision: integer("delivered_revision").notNull().default(0),
		failedRevision: integer("failed_revision").notNull().default(0),
		failedAt: timestamp("failed_at"),
		attempts: integer().notNull().default(0),
		availableAt: timestamp("available_at").notNull().defaultNow(),
		claimedBy: uuid("claimed_by"),
		claimedUntil: timestamp("claimed_until"),
		lastError: text("last_error"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [
		check("chk_github_update_outbox_phase", sql`${table.phase} IN ('started', 'terminal')`),
		check(
			"chk_github_update_outbox_revisions",
			sql`${table.revision} >= 1 AND ${table.deliveredRevision} >= 0 AND ${table.deliveredRevision} <= ${table.revision} AND ${table.failedRevision} >= 0 AND ${table.failedRevision} <= ${table.revision}`,
		),
		uniqueIndex("idx_github_update_outbox_update_phase").on(table.updateId, table.phase),
		index("idx_github_update_outbox_available").on(table.availableAt, table.claimedUntil),
	],
);

// ============================================================================
// journal_entries — Per-resource journal entries for journaling protocol
// ============================================================================

export const journalEntries = pgTable(
	"journal_entries",
	{
		id: uuid().primaryKey().defaultRandom(),
		updateId: uuid("update_id")
			.notNull()
			.references(() => updates.id, { onDelete: "cascade" }),
		stackId: uuid("stack_id").notNull(),
		sequenceId: bigint("sequence_id", { mode: "bigint" }).notNull(),
		operationId: bigint("operation_id", { mode: "bigint" }).notNull(),
		kind: integer().notNull(),
		state: jsonb(),
		operation: jsonb(),
		secretsProvider: jsonb("secrets_provider"),
		newSnapshot: jsonb("new_snapshot"),
		operationType: text("operation_type"),
		removeOld: bigint("remove_old", { mode: "bigint" }),
		removeNew: bigint("remove_new", { mode: "bigint" }),
		pendingReplacementOld: bigint("pending_replacement_old", { mode: "bigint" }),
		pendingReplacementNew: bigint("pending_replacement_new", { mode: "bigint" }),
		deleteOld: bigint("delete_old", { mode: "bigint" }),
		deleteNew: bigint("delete_new", { mode: "bigint" }),
		isRefresh: boolean("is_refresh").notNull().default(false),
		elideWrite: boolean("elide_write").notNull().default(false),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => [uniqueIndex("idx_journal_entries_update_seq").on(table.updateId, table.sequenceId)],
);

export const webhooks = pgTable(
	"webhooks",
	{
		id: uuid().primaryKey().defaultRandom(),
		tenantId: text("tenant_id").notNull(),
		name: text().notNull(),
		url: text().notNull(),
		secret: text().notNull(),
		events: text().array().notNull(),
		active: boolean().notNull().default(true),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [index("idx_webhooks_tenant").on(table.tenantId)],
);

export const webhookDeliveries = pgTable(
	"webhook_deliveries",
	{
		id: uuid().primaryKey().defaultRandom(),
		webhookId: uuid("webhook_id")
			.notNull()
			.references(() => webhooks.id, { onDelete: "cascade" }),
		event: text().notNull(),
		payload: jsonb().notNull(),
		requestHeaders: jsonb("request_headers"),
		responseStatus: integer("response_status"),
		responseBody: text("response_body"),
		responseHeaders: jsonb("response_headers"),
		duration: integer(),
		attempt: integer().notNull().default(1),
		success: boolean().notNull().default(false),
		error: text(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => [
		index("idx_deliveries_webhook").on(table.webhookId),
		index("idx_deliveries_created").on(table.createdAt.desc()),
	],
);

export const githubInstallations = pgTable(
	"github_installations",
	{
		id: uuid().primaryKey().defaultRandom(),
		tenantId: text("tenant_id").notNull(),
		installationId: integer("installation_id").notNull(),
		accountLogin: text("account_login").notNull(),
		accountType: text("account_type").notNull(),
		repositorySelection: text("repository_selection").notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [
		index("idx_github_tenant").on(table.tenantId),
		uniqueIndex("idx_github_installation_id").on(table.installationId),
	],
);

export const githubSetupStates = pgTable(
	"github_setup_states",
	{
		jti: uuid().primaryKey(),
		tenantId: text("tenant_id").notNull(),
		expiresAt: timestamp("expires_at").notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => [index("idx_github_setup_states_expires").on(table.expiresAt)],
);

export const oidcTrustPolicies = pgTable(
	"oidc_trust_policies",
	{
		id: uuid().primaryKey().defaultRandom(),
		tenantId: text("tenant_id").notNull(),
		orgSlug: text("org_slug").notNull(),
		provider: text().notNull(),
		displayName: text("display_name").notNull(),
		issuer: text().notNull(),
		maxExpiration: integer("max_expiration").notNull().default(7200),
		claimConditions: jsonb("claim_conditions").notNull().$type<Record<string, string>>(),
		grantedRole: text("granted_role").notNull(),
		active: boolean().notNull().default(true),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [
		index("idx_oidc_trust_tenant").on(table.tenantId),
		uniqueIndex("idx_oidc_trust_org_name").on(table.tenantId, table.orgSlug, table.displayName),
		uniqueIndex("idx_oidc_trust_org_issuer").on(table.orgSlug, table.issuer),
	],
);

// ============================================================================
// esc_projects — ESC project registry (tenant-scoped). Independent of
// Pulumi `projects` above because ESC has its own project namespace.
// ============================================================================

export const escProjects = pgTable(
	"esc_projects",
	{
		id: uuid().primaryKey().defaultRandom(),
		tenantId: text("tenant_id").notNull(),
		name: text().notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [uniqueIndex("idx_esc_projects_tenant_name").on(table.tenantId, table.name)],
);

// ============================================================================
// esc_environments — Current environment YAML body. Soft-delete via
// `deleted_at`. The body here always equals the latest revision's body;
// revisions are immutable history.
// ============================================================================

export const escEnvironments = pgTable(
	"esc_environments",
	{
		id: uuid().primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => escProjects.id, { onDelete: "cascade" }),
		name: text().notNull(),
		yamlBody: text("yaml_body").notNull(),
		currentRevisionNumber: integer("current_revision_number").notNull().default(1),
		createdBy: text("created_by").notNull(),
		tags: jsonb().$type<Record<string, string>>().notNull().default({}),
		deletedAt: timestamp("deleted_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("idx_esc_envs_project_name")
			.on(table.projectId, table.name)
			.where(sql`deleted_at IS NULL`),
	],
);

// ============================================================================
// esc_environment_revisions — Immutable revision history per environment.
// Incrementing `revision_number` per env.
// ============================================================================

export const escEnvironmentRevisions = pgTable(
	"esc_environment_revisions",
	{
		id: uuid().primaryKey().defaultRandom(),
		environmentId: uuid("environment_id")
			.notNull()
			.references(() => escEnvironments.id, { onDelete: "cascade" }),
		revisionNumber: integer("revision_number").notNull(),
		yamlBody: text("yaml_body").notNull(),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("idx_esc_revisions_env_number").on(table.environmentId, table.revisionNumber),
	],
);

// ============================================================================
// esc_sessions — Resolved environment values. `resolved_values_ciphertext`
// is AES-256-GCM encrypted JSON; nonce prepended per crypto pkg convention.
// GC cron cleans up rows where `expires_at < now()` AND `closed_at IS NULL`.
// ============================================================================

export const escSessions = pgTable(
	"esc_sessions",
	{
		id: uuid().primaryKey().defaultRandom(),
		environmentId: uuid("environment_id")
			.notNull()
			.references(() => escEnvironments.id, { onDelete: "cascade" }),
		revisionId: uuid("revision_id")
			.notNull()
			.references(() => escEnvironmentRevisions.id, { onDelete: "cascade" }),
		resolvedValuesCiphertext: text("resolved_values_ciphertext").notNull(),
		secretPaths: text("secret_paths").array().notNull().default(sql`'{}'::text[]`),
		openedAt: timestamp("opened_at").notNull().defaultNow(),
		expiresAt: timestamp("expires_at").notNull(),
		closedAt: timestamp("closed_at"),
	},
	(table) => [
		index("idx_esc_sessions_env").on(table.environmentId),
		index("idx_esc_sessions_expires_active").on(table.expiresAt).where(sql`closed_at IS NULL`),
	],
);

// ============================================================================
// esc_revision_tags — Named references to specific revisions (e.g. "stable").
// Unique per (environment_id, name) so one tag name maps to exactly one
// revision within an environment. Applying a tag to a new revision uses upsert.
// ============================================================================

export const escRevisionTags = pgTable(
	"esc_revision_tags",
	{
		id: uuid().primaryKey().defaultRandom(),
		environmentId: uuid("environment_id")
			.notNull()
			.references(() => escEnvironments.id, { onDelete: "cascade" }),
		revisionId: uuid("revision_id")
			.notNull()
			.references(() => escEnvironmentRevisions.id, { onDelete: "cascade" }),
		name: text().notNull(),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("idx_esc_rev_tags_env_name").on(table.environmentId, table.name),
		index("idx_esc_rev_tags_revision").on(table.revisionId),
	],
);

// ============================================================================
// esc_drafts — Proposed changes that require review before applying.
// Status transitions: open → applied | discarded. Once applied, the
// applied_revision_id links to the revision created by applyDraft.
// ============================================================================

export const escDrafts = pgTable(
	"esc_drafts",
	{
		id: uuid().primaryKey().defaultRandom(),
		environmentId: uuid("environment_id")
			.notNull()
			.references(() => escEnvironments.id, { onDelete: "cascade" }),
		yamlBody: text("yaml_body").notNull(),
		description: text().notNull().default(""),
		createdBy: text("created_by").notNull(),
		status: text().notNull().default("open"),
		appliedRevisionId: uuid("applied_revision_id").references(() => escEnvironmentRevisions.id),
		appliedAt: timestamp("applied_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [
		index("idx_esc_drafts_env").on(table.environmentId),
		index("idx_esc_drafts_status").on(table.environmentId, table.status),
	],
);

// ============================================================================
// Schema export — pass to drizzle() for relational queries
// ============================================================================

export const schema = {
	projects,
	stacks,
	updates,
	checkpoints,
	updateEvents,
	githubUpdateOutbox,
	journalEntries,
	webhooks,
	webhookDeliveries,
	githubInstallations,
	githubSetupStates,
	oidcTrustPolicies,
	escProjects,
	escEnvironments,
	escEnvironmentRevisions,
	escSessions,
	escRevisionTags,
	escDrafts,
};
