import { describe, expect, test } from "bun:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	blobCleanupQueue,
	checkpoints,
	githubInstallations,
	githubOutboundConnections,
	githubSetupStates,
	oidcTrustPolicies,
	projects,
	stacks,
	subscriptionTicketNonces,
	updateEvents,
	updates,
} from "./schema.js";

describe("@procella/db schema", () => {
	describe("projects table", () => {
		test("is named 'projects'", () => {
			expect(getTableName(projects)).toBe("projects");
		});

		test("has tenant_id column", () => {
			const columns = getTableColumns(projects);
			expect(columns.tenantId).toBeDefined();
			expect(columns.tenantId.name).toBe("tenant_id");
			expect(columns.tenantId.notNull).toBe(true);
		});

		test("has required columns", () => {
			const columns = getTableColumns(projects);
			const columnNames = Object.values(columns).map((c) => c.name);
			expect(columnNames).toContain("id");
			expect(columnNames).toContain("tenant_id");
			expect(columnNames).toContain("name");
			expect(columnNames).toContain("description");
			expect(columnNames).toContain("created_at");
			expect(columnNames).toContain("updated_at");
		});
	});

	describe("stacks table", () => {
		test("is named 'stacks'", () => {
			expect(getTableName(stacks)).toBe("stacks");
		});

		test("has project_id column with FK", () => {
			const columns = getTableColumns(stacks);
			expect(columns.projectId).toBeDefined();
			expect(columns.projectId.name).toBe("project_id");
			expect(columns.projectId.notNull).toBe(true);
		});

		test("has tags and active_update_id columns", () => {
			const columns = getTableColumns(stacks);
			expect(columns.tags).toBeDefined();
			expect(columns.tags.name).toBe("tags");
			expect(columns.activeUpdateId).toBeDefined();
			expect(columns.activeUpdateId.name).toBe("active_update_id");
		});
	});

	describe("updates table", () => {
		test("is named 'updates'", () => {
			expect(getTableName(updates)).toBe("updates");
		});

		test("has stack_id as a cascading stack reference", () => {
			const columns = getTableColumns(updates);
			expect(columns.stackId).toBeDefined();
			expect(columns.stackId.name).toBe("stack_id");
			expect(columns.stackId.notNull).toBe(true);
		});

		test("indexes stack_id for bounded cascade lookup", () => {
			const stackIndex = getTableConfig(updates).indexes.find(
				(candidate) => candidate.config.name === "idx_updates_stack_id",
			);
			expect(
				stackIndex?.config.columns.map((column) => ("name" in column ? column.name : null)),
			).toEqual(["stack_id"]);
		});

		test("has lifecycle columns", () => {
			const columns = getTableColumns(updates);
			const columnNames = Object.values(columns).map((c) => c.name);
			expect(columnNames).toContain("kind");
			expect(columnNames).toContain("status");
			expect(columnNames).toContain("result");
			expect(columnNames).toContain("version");
			expect(columnNames).toContain("lease_token");
			expect(columnNames).toContain("lease_expires_at");
			expect(columnNames).toContain("started_at");
			expect(columnNames).toContain("completed_at");
			expect(columnNames).toContain("config");
			expect(columnNames).toContain("program");
			expect(columnNames).toContain("environment");
		});
	});

	describe("blob_cleanup_queue table", () => {
		test("stores durable exact-key claims", () => {
			expect(getTableName(blobCleanupQueue)).toBe("blob_cleanup_queue");
			const columns = getTableColumns(blobCleanupQueue);
			expect(columns.blobKey.name).toBe("blob_key");
			expect(columns.attempts.name).toBe("attempts");
			expect(columns.availableAt.name).toBe("available_at");
			expect(columns.claimedBy.name).toBe("claimed_by");
			expect(columns.claimedUntil.name).toBe("claimed_until");
			expect(columns.lastError.name).toBe("last_error");
		});
	});

	describe("checkpoints table", () => {
		test("is named 'checkpoints'", () => {
			expect(getTableName(checkpoints)).toBe("checkpoints");
		});

		test("has update_id and blob_key columns", () => {
			const columns = getTableColumns(checkpoints);
			expect(columns.updateId).toBeDefined();
			expect(columns.updateId.name).toBe("update_id");
			expect(columns.updateId.notNull).toBe(true);
			expect(columns.blobKey).toBeDefined();
			expect(columns.blobKey.name).toBe("blob_key");
		});

		test("has is_delta boolean column", () => {
			const columns = getTableColumns(checkpoints);
			expect(columns.isDelta).toBeDefined();
			expect(columns.isDelta.name).toBe("is_delta");
			expect(columns.isDelta.notNull).toBe(true);
		});
	});

	describe("update_events table", () => {
		test("is named 'update_events'", () => {
			expect(getTableName(updateEvents)).toBe("update_events");
		});

		test("has sequence column", () => {
			const columns = getTableColumns(updateEvents);
			expect(columns.sequence).toBeDefined();
			expect(columns.sequence.name).toBe("sequence");
			expect(columns.sequence.notNull).toBe(true);
		});

		test("has required columns", () => {
			const columns = getTableColumns(updateEvents);
			const columnNames = Object.values(columns).map((c) => c.name);
			expect(columnNames).toContain("id");
			expect(columnNames).toContain("update_id");
			expect(columnNames).toContain("sequence");
			expect(columnNames).toContain("kind");
			expect(columnNames).toContain("fields");
			expect(columnNames).toContain("created_at");
		});
	});

	describe("github_installations table", () => {
		test("is named 'github_installations'", () => {
			expect(getTableName(githubInstallations)).toBe("github_installations");
		});

		test("has tenant and installation columns", () => {
			const columns = getTableColumns(githubInstallations);
			expect(columns.tenantId.name).toBe("tenant_id");
			expect(columns.installationId.name).toBe("installation_id");
			expect(columns.accountLogin.name).toBe("account_login");
			expect(columns.accountType.name).toBe("account_type");
			expect(columns.repositorySelection.name).toBe("repository_selection");
		});
	});

	describe("github_setup_states table", () => {
		test("stores tenant-bound one-time state", () => {
			expect(getTableName(githubSetupStates)).toBe("github_setup_states");
			const columns = getTableColumns(githubSetupStates);
			expect(columns.jti.name).toBe("jti");
			expect(columns.tenantId.name).toBe("tenant_id");
			expect(columns.expiresAt.name).toBe("expires_at");
		});
	});

	describe("subscription_ticket_nonces table", () => {
		test("stores expiring single-use nonces", () => {
			expect(getTableName(subscriptionTicketNonces)).toBe("subscription_ticket_nonces");
			const columns = getTableColumns(subscriptionTicketNonces);
			expect(columns.nonce.primary).toBe(true);
			expect(columns.expiresAt.name).toBe("expires_at");
			expect(columns.expiresAt.notNull).toBe(true);
			expect(columns.expiresAt.getSQLType()).toBe("timestamp with time zone");
			expect(
				getTableConfig(subscriptionTicketNonces).indexes.some(
					(index) => index.config.name === "idx_subscription_ticket_nonces_expires",
				),
			).toBe(true);
		});

		test("0022 snapshot records the replay table", async () => {
			const snapshot = (await Bun.file(
				new URL("../drizzle/meta/0022_snapshot.json", import.meta.url),
			).json()) as {
				tables: Record<
					string,
					{
						columns: Record<string, { type: string }>;
						indexes: Record<string, unknown>;
					}
				>;
			};
			const table = snapshot.tables["public.subscription_ticket_nonces"];
			expect(table?.columns.expires_at.type).toBe("timestamp with time zone");
			expect(table?.indexes.idx_subscription_ticket_nonces_expires).toBeDefined();
		});

		test("keeps the applied 0022 migration marker stable at idx 22, after siblings 0020/0021", async () => {
			const journal = (await Bun.file(
				new URL("../drizzle/meta/_journal.json", import.meta.url),
			).json()) as { entries: Array<{ idx: number; tag: string; when: number }> };

			const byTag = Object.fromEntries(journal.entries.map((entry) => [entry.tag, entry]));
			expect(byTag["0020_durable_blob_cleanup"]?.idx).toBe(20);
			expect(byTag["0021_webhook_delivery_outbox"]?.idx).toBe(21);
			expect(byTag["0022_single_use_subscription_tickets"]?.idx).toBe(22);
			expect(byTag["0022_single_use_subscription_tickets"]?.when).toBe(1788703548917);
			expect(byTag["0022_single_use_subscription_tickets"]?.when).toBeGreaterThan(
				byTag["0021_webhook_delivery_outbox"]?.when ?? 0,
			);
		});

		test("orders every migration marker so none is skipped on a migrated database", async () => {
			const journal = (await Bun.file(
				new URL("../drizzle/meta/_journal.json", import.meta.url),
			).json()) as { entries: Array<{ idx: number; tag: string; when: number }> };

			// drizzle compares each entry against the newest marker already recorded in
			// __drizzle_migrations, so an entry that is not strictly newer than the one
			// before it is skipped forever once its predecessors have been applied.
			expect(journal.entries.map((entry) => entry.idx)).toEqual(
				journal.entries.map((_entry, index) => index),
			);
			expect(
				journal.entries.filter(
					(entry, index) => index > 0 && entry.when <= (journal.entries[index - 1]?.when ?? 0),
				),
			).toEqual([]);
		});
	});

	describe("oidc_trust_policies table", () => {
		test("has tenant-scoped policy columns", () => {
			const columns = getTableColumns(oidcTrustPolicies);
			expect(columns.tenantId.name).toBe("tenant_id");
			expect(columns.orgSlug.name).toBe("org_slug");
			expect(columns.issuer.name).toBe("issuer");
		});

		test("indexes ownership lookups without placing claim JSON in a B-tree key", () => {
			const index = getTableConfig(oidcTrustPolicies).indexes.find(
				(candidate) => candidate.config.name === "idx_oidc_trust_org_issuer",
			);

			expect(index?.config.unique).toBe(false);
			expect(
				index?.config.columns.map((column) => ("name" in column ? column.name : undefined)),
			).toEqual(["org_slug", "issuer"]);
		});
	});

	describe("github_outbound_connections table", () => {
		test("records one confirmed Descope token per tenant and user", () => {
			expect(getTableName(githubOutboundConnections)).toBe("github_outbound_connections");
			const columns = getTableColumns(githubOutboundConnections);
			expect(columns.tenantId.name).toBe("tenant_id");
			expect(columns.userId.name).toBe("user_id");
			expect(columns.tokenId.name).toBe("token_id");
			expect(columns.updatedAt.name).toBe("updated_at");

			const index = getTableConfig(githubOutboundConnections).indexes.find(
				(candidate) => candidate.config.name === "idx_github_outbound_connection_owner",
			);
			expect(index?.config.unique).toBe(true);
			expect(
				index?.config.columns.map((column) => ("name" in column ? column.name : undefined)),
			).toEqual(["tenant_id", "user_id"]);
		});

		test("0023 snapshot carries the confirmation table", async () => {
			const snapshot = (await Bun.file(
				new URL("../drizzle/meta/0023_snapshot.json", import.meta.url),
			).json()) as {
				tables: Record<
					string,
					{ columns: Record<string, unknown>; indexes: Record<string, { isUnique: boolean }> }
				>;
			};
			const table = snapshot.tables["public.github_outbound_connections"];
			expect(table?.columns.token_id).toBeDefined();
			expect(table?.indexes.idx_github_outbound_connection_owner?.isUnique).toBe(true);
		});
	});

	describe("migration journal", () => {
		test("keeps portfolio migrations 0020 through 0025 in order", async () => {
			const journal = (await Bun.file(
				new URL("../drizzle/meta/_journal.json", import.meta.url),
			).json()) as { entries: Array<{ idx: number; tag: string }> };
			const expected = [
				{ idx: 20, tag: "0020_durable_blob_cleanup" },
				{ idx: 21, tag: "0021_webhook_delivery_outbox" },
				{ idx: 22, tag: "0022_single_use_subscription_tickets" },
				{ idx: 23, tag: "0023_confirmed_github_outbound_connections" },
				{ idx: 24, tag: "0024_multi_repository_github_actions" },
				{ idx: 25, tag: "0025_managed_esc_environments" },
			];

			expect(journal.entries.slice(-expected.length)).toEqual(
				expected.map(({ idx, tag }) => expect.objectContaining({ idx, tag })),
			);
			for (const { tag } of expected) {
				expect(await Bun.file(new URL(`../drizzle/${tag}.sql`, import.meta.url)).exists()).toBe(
					true,
				);
			}
		});
	});

	describe("all tables", () => {
		test("all tables are defined", () => {
			expect(getTableName(projects)).toBe("projects");
			expect(getTableName(stacks)).toBe("stacks");
			expect(getTableName(updates)).toBe("updates");
			expect(getTableName(checkpoints)).toBe("checkpoints");
			expect(getTableName(blobCleanupQueue)).toBe("blob_cleanup_queue");
			expect(getTableName(updateEvents)).toBe("update_events");
			expect(getTableName(githubInstallations)).toBe("github_installations");
			expect(getTableName(githubSetupStates)).toBe("github_setup_states");
			expect(getTableName(githubOutboundConnections)).toBe("github_outbound_connections");
			expect(getTableName(subscriptionTicketNonces)).toBe("subscription_ticket_nonces");
			expect(getTableName(oidcTrustPolicies)).toBe("oidc_trust_policies");
		});

		test("all tables have id and created_at columns", () => {
			for (const table of [
				projects,
				stacks,
				updates,
				checkpoints,
				blobCleanupQueue,
				updateEvents,
				oidcTrustPolicies,
			]) {
				const columns = getTableColumns(table);
				const columnNames = Object.values(columns).map((c) => c.name);
				expect(columnNames).toContain("id");
				expect(columnNames).toContain("created_at");
			}
		});
	});
});
