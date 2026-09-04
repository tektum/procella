import { describe, expect, test } from "bun:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import {
	checkpoints,
	githubInstallations,
	githubSetupStates,
	oidcTrustPolicies,
	projects,
	stacks,
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

		test("has stack_id as soft reference (not null)", () => {
			const columns = getTableColumns(updates);
			expect(columns.stackId).toBeDefined();
			expect(columns.stackId.name).toBe("stack_id");
			expect(columns.stackId.notNull).toBe(true);
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

	describe("oidc_trust_policies table", () => {
		test("has tenant-scoped policy columns", () => {
			const columns = getTableColumns(oidcTrustPolicies);
			expect(columns.tenantId.name).toBe("tenant_id");
			expect(columns.orgSlug.name).toBe("org_slug");
			expect(columns.issuer.name).toBe("issuer");
		});
	});

	describe("all tables", () => {
		test("all tables are defined", () => {
			expect(getTableName(projects)).toBe("projects");
			expect(getTableName(stacks)).toBe("stacks");
			expect(getTableName(updates)).toBe("updates");
			expect(getTableName(checkpoints)).toBe("checkpoints");
			expect(getTableName(updateEvents)).toBe("update_events");
			expect(getTableName(githubInstallations)).toBe("github_installations");
			expect(getTableName(githubSetupStates)).toBe("github_setup_states");
			expect(getTableName(oidcTrustPolicies)).toBe("oidc_trust_policies");
		});

		test("all tables have id and created_at columns", () => {
			for (const table of [
				projects,
				stacks,
				updates,
				checkpoints,
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
