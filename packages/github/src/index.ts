import { randomUUID, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Config } from "@procella/config";
import type { Database } from "@procella/db";
import { githubInstallations, githubSetupStates } from "@procella/db";
import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import { errors as joseErrors, jwtVerify, SignJWT } from "jose";

export interface GitHubInstallationData {
	installationId: number;
	accountLogin: string;
	accountType: "Organization" | "User";
	repositorySelection: "all" | "selected";
}

export interface GitHubInstallationInfo extends GitHubInstallationData {
	id: string;
	tenantId: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface GitHubAppConfig {
	appId: string;
	slug: string;
	privateKey: string;
	webhookSecret: string;
	stateSigningKey: string;
}

export interface GitHubRepositoryTarget {
	tenantId: string;
	owner: string;
	repo: string;
}

export interface GitHubService {
	handleWebhookEvent(event: string, payload: unknown): Promise<void>;
	issueInstallationUrl(tenantId: string): Promise<string>;
	completeInstallation(state: string, installationId: number): Promise<GitHubInstallationInfo>;
	listInstallations(tenantId: string): Promise<GitHubInstallationInfo[]>;
	resolveInstallation(target: GitHubRepositoryTarget): Promise<GitHubInstallationInfo | null>;
	removeInstallation(tenantId: string, installationId: number): Promise<void>;
	postPRComment(
		installationId: number,
		owner: string,
		repo: string,
		prNumber: number,
		body: string,
	): Promise<void>;
	setCommitStatus(
		installationId: number,
		owner: string,
		repo: string,
		sha: string,
		state: "pending" | "success" | "failure" | "error",
		description: string,
		context?: string,
	): Promise<void>;
}

export const GITHUB_SETUP_STATE_TTL_SECONDS = 10 * 60;
const GITHUB_SETUP_STATE_ISSUER = "procella";
const GITHUB_SETUP_STATE_AUDIENCE = "procella:github-app-installation";

export type GitHubSetupErrorCode =
	| "invalid_state"
	| "expired_state"
	| "replayed_state"
	| "installation_conflict"
	| "invalid_installation";

export class GitHubSetupError extends Error {
	constructor(readonly code: GitHubSetupErrorCode) {
		super(code);
		this.name = "GitHubSetupError";
	}
}

export interface GitHubSetupStateClaims {
	tenantId: string;
	jti: string;
	expiresAt: Date;
}

export interface GitHubSetupStateService {
	issue(tenantId: string): Promise<{ state: string; claims: GitHubSetupStateClaims }>;
	verify(state: string): Promise<GitHubSetupStateClaims>;
}

export function createGitHubSetupStateService(
	signingKey: string,
	options: { now?: () => Date; ttlSeconds?: number } = {},
): GitHubSetupStateService {
	const secret = new TextEncoder().encode(signingKey);
	const now = options.now ?? (() => new Date());
	const ttlSeconds = options.ttlSeconds ?? GITHUB_SETUP_STATE_TTL_SECONDS;

	return {
		async issue(tenantId) {
			const issuedAt = Math.floor(now().getTime() / 1000);
			const expiresAt = issuedAt + ttlSeconds;
			const jti = randomUUID();
			const state = await new SignJWT({ tenantId })
				.setProtectedHeader({ alg: "HS256", typ: "JWT" })
				.setIssuer(GITHUB_SETUP_STATE_ISSUER)
				.setAudience(GITHUB_SETUP_STATE_AUDIENCE)
				.setJti(jti)
				.setIssuedAt(issuedAt)
				.setExpirationTime(expiresAt)
				.sign(secret);
			return { state, claims: { tenantId, jti, expiresAt: new Date(expiresAt * 1000) } };
		},
		async verify(state) {
			try {
				const { payload } = await jwtVerify(state, secret, {
					algorithms: ["HS256"],
					audience: GITHUB_SETUP_STATE_AUDIENCE,
					issuer: GITHUB_SETUP_STATE_ISSUER,
					currentDate: now(),
				});
				if (
					typeof payload.tenantId !== "string" ||
					payload.tenantId.length === 0 ||
					typeof payload.jti !== "string" ||
					!payload.exp
				) {
					throw new GitHubSetupError("invalid_state");
				}
				return {
					tenantId: payload.tenantId,
					jti: payload.jti,
					expiresAt: new Date(payload.exp * 1000),
				};
			} catch (error) {
				if (error instanceof GitHubSetupError) throw error;
				if (error instanceof joseErrors.JWTExpired) {
					throw new GitHubSetupError("expired_state");
				}
				throw new GitHubSetupError("invalid_state");
			}
		},
	};
}

export function buildGitHubAppConfig(config: Config): GitHubAppConfig | null {
	if (
		!config.githubAppId ||
		!config.githubAppSlug ||
		!config.githubAppPrivateKey ||
		!config.githubAppWebhookSecret ||
		!config.ticketSigningKey
	) {
		return null;
	}

	return {
		appId: config.githubAppId,
		slug: config.githubAppSlug,
		privateKey: config.githubAppPrivateKey,
		webhookSecret: config.githubAppWebhookSecret,
		stateSigningKey: config.ticketSigningKey,
	};
}

export async function verifyGitHubWebhookSignature(
	payload: string,
	signature: string,
	secret: string,
): Promise<boolean> {
	if (!signature?.startsWith("sha256=")) {
		return false;
	}

	const expected = signature.slice(7);
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	const computed = Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	const computedBuf = Buffer.from(computed, "hex");
	const expectedBuf = Buffer.from(expected, "hex");
	if (computedBuf.length !== expectedBuf.length) {
		return false;
	}

	return timingSafeEqual(computedBuf, expectedBuf);
}

export function buildPRCommentBody(update: {
	org: string;
	project: string;
	stack: string;
	kind: string;
	status: string;
	resourceChanges?: { creates?: number; updates?: number; deletes?: number; sames?: number };
	permalink?: string;
}): string {
	const statusLabel =
		update.status === "succeeded"
			? "✅ succeeded"
			: update.status === "failed"
				? "❌ failed"
				: update.status === "cancelled"
					? "⚪ cancelled"
					: update.status;

	const creates = update.resourceChanges?.creates ?? 0;
	const updates = update.resourceChanges?.updates ?? 0;
	const deletes = update.resourceChanges?.deletes ?? 0;
	const sames = update.resourceChanges?.sames ?? 0;

	const lines = [
		"## Pulumi Preview Results",
		`**Stack:** \`${update.org}/${update.project}/${update.stack}\``,
		`**Operation:** ${update.kind}`,
		`**Status:** ${statusLabel}`,
		"",
		"| Action | Count |",
		"|--------|-------|",
		`| Create | ${creates} |`,
		`| Update | ${updates} |`,
		`| Delete | ${deletes} |`,
		`| Same | ${sames} |`,
	];

	if (update.permalink) {
		lines.push("", `[View details](${update.permalink})`);
	}

	return lines.join("\n");
}

export function mapUpdateStatusToCommitState(
	status: string,
): "pending" | "success" | "failure" | "error" {
	if (status === "succeeded") {
		return "success";
	}
	if (status === "failed" || status === "cancelled") {
		return "failure";
	}
	if (status === "running" || status === "requested" || status === "not started") {
		return "pending";
	}
	return "error";
}

export class OctokitGitHubService implements GitHubService {
	private readonly db: Database;
	private readonly config: GitHubAppConfig;
	private readonly appClient: Octokit;
	private readonly installationClientFactory: (installationId: number) => Octokit;
	private readonly setupStates: GitHubSetupStateService;

	constructor({
		db,
		config,
		appClient,
		installationClientFactory,
		setupStates,
	}: {
		db: Database;
		config: GitHubAppConfig;
		appClient?: Octokit;
		installationClientFactory?: (installationId: number) => Octokit;
		setupStates?: GitHubSetupStateService;
	}) {
		this.db = db;
		this.config = config;
		this.appClient = appClient ?? this.createAppClient();
		this.installationClientFactory =
			installationClientFactory ??
			((installationId) => this.createInstallationClient(installationId));
		this.setupStates = setupStates ?? createGitHubSetupStateService(config.stateSigningKey);
	}

	async issueInstallationUrl(tenantId: string): Promise<string> {
		const { state, claims } = await this.setupStates.issue(tenantId);
		await this.db.delete(githubSetupStates).where(lt(githubSetupStates.expiresAt, sql`now()`));
		await this.db.insert(githubSetupStates).values({
			jti: claims.jti,
			tenantId: claims.tenantId,
			expiresAt: claims.expiresAt,
		});

		const url = new URL(`https://github.com/apps/${this.config.slug}/installations/new`);
		url.searchParams.set("state", state);
		return url.toString();
	}

	async completeInstallation(
		state: string,
		installationId: number,
	): Promise<GitHubInstallationInfo> {
		const claims = await this.setupStates.verify(state);
		const installation = await this.loadInstallation(installationId);

		return this.db.transaction(async (tx) => {
			const [consumed] = await tx
				.delete(githubSetupStates)
				.where(
					and(
						eq(githubSetupStates.jti, claims.jti),
						eq(githubSetupStates.tenantId, claims.tenantId),
						gt(githubSetupStates.expiresAt, sql`now()`),
					),
				)
				.returning({ jti: githubSetupStates.jti });
			if (!consumed) throw new GitHubSetupError("replayed_state");

			return this.saveInstallation(claims.tenantId, installation, tx as Database);
		});
	}

	async handleWebhookEvent(event: string, payload: unknown): Promise<void> {
		if (event !== "installation" && event !== "installation_repositories") return;

		const body = payload as {
			action?: string;
			installation?: {
				id?: number;
				account?: { login?: string; type?: "Organization" | "User" };
				repository_selection?: "all" | "selected";
			};
		};
		const installation = body.installation;
		if (!Number.isSafeInteger(installation?.id) || (installation?.id ?? 0) <= 0) return;

		const existing = await this.getInstallationById(installation?.id as number);
		if (!existing) return;

		if (event === "installation" && body.action === "deleted") {
			await this.removeInstallationById(existing.installationId);
			return;
		}

		const accountLogin = installation?.account?.login;
		const accountType = installation?.account?.type;
		const repositorySelection = installation?.repository_selection;
		await this.db
			.update(githubInstallations)
			.set({
				...(accountLogin ? { accountLogin } : {}),
				...(accountType === "Organization" || accountType === "User" ? { accountType } : {}),
				...(repositorySelection === "all" || repositorySelection === "selected"
					? { repositorySelection }
					: {}),
				updatedAt: sql`now()`,
			})
			.where(eq(githubInstallations.installationId, existing.installationId));
	}

	async listInstallations(tenantId: string): Promise<GitHubInstallationInfo[]> {
		const rows = await this.db
			.select()
			.from(githubInstallations)
			.where(eq(githubInstallations.tenantId, tenantId))
			.orderBy(desc(githubInstallations.updatedAt));
		return rows.map(mapInstallationRow);
	}

	async resolveInstallation(
		target: GitHubRepositoryTarget,
	): Promise<GitHubInstallationInfo | null> {
		const installations = await this.listInstallations(target.tenantId);

		try {
			const { data } = await this.appClient.request("GET /repos/{owner}/{repo}/installation", {
				owner: target.owner,
				repo: target.repo,
			});
			if (!Number.isSafeInteger(data.id)) return null;
			return installations.find((installation) => installation.installationId === data.id) ?? null;
		} catch {
			// The app-JWT endpoint is authoritative for repository selection. Any
			// lookup failure denies access, including public repository metadata access.
			return null;
		}
	}

	async removeInstallation(tenantId: string, installationId: number): Promise<void> {
		await this.db
			.delete(githubInstallations)
			.where(
				and(
					eq(githubInstallations.tenantId, tenantId),
					eq(githubInstallations.installationId, installationId),
				),
			);
	}

	async postPRComment(
		installationId: number,
		owner: string,
		repo: string,
		prNumber: number,
		body: string,
	): Promise<void> {
		const octokit = this.installationClientFactory(installationId);
		await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
	}

	async setCommitStatus(
		installationId: number,
		owner: string,
		repo: string,
		sha: string,
		state: "pending" | "success" | "failure" | "error",
		description: string,
		context = "procella/preview",
	): Promise<void> {
		const octokit = this.installationClientFactory(installationId);
		await octokit.rest.repos.createCommitStatus({
			owner,
			repo,
			sha,
			state,
			description,
			context,
		});
	}

	private async saveInstallation(
		tenantId: string,
		installation: GitHubInstallationData,
		database: Database = this.db,
	): Promise<GitHubInstallationInfo> {
		const [row] = await database
			.insert(githubInstallations)
			.values({ tenantId, ...installation })
			.onConflictDoUpdate({
				target: githubInstallations.installationId,
				set: {
					accountLogin: installation.accountLogin,
					accountType: installation.accountType,
					repositorySelection: installation.repositorySelection,
					updatedAt: sql`now()`,
				},
				setWhere: eq(githubInstallations.tenantId, tenantId),
			})
			.returning();

		if (!row) throw new GitHubSetupError("installation_conflict");
		return mapInstallationRow(row);
	}

	private async getInstallationById(
		installationId: number,
	): Promise<GitHubInstallationInfo | null> {
		const [row] = await this.db
			.select()
			.from(githubInstallations)
			.where(eq(githubInstallations.installationId, installationId))
			.limit(1);
		return row ? mapInstallationRow(row) : null;
	}

	private async removeInstallationById(installationId: number): Promise<void> {
		await this.db
			.delete(githubInstallations)
			.where(eq(githubInstallations.installationId, installationId));
	}

	private async loadInstallation(installationId: number): Promise<GitHubInstallationData> {
		try {
			const { data } = await this.appClient.request("GET /app/installations/{installation_id}", {
				installation_id: installationId,
			});
			const account = data.account;
			const accountLogin =
				typeof account === "object" && account && "login" in account ? account.login : undefined;
			const accountType = data.target_type;
			const appId = Number(data.app_id);
			const repositorySelection = data.repository_selection;
			if (
				appId !== Number(this.config.appId) ||
				data.id !== installationId ||
				typeof accountLogin !== "string" ||
				(accountType !== "Organization" && accountType !== "User") ||
				(repositorySelection !== "all" && repositorySelection !== "selected")
			) {
				throw new GitHubSetupError("invalid_installation");
			}

			return { installationId, accountLogin, accountType, repositorySelection };
		} catch (error) {
			if (error instanceof GitHubSetupError) throw error;
			throw new GitHubSetupError("invalid_installation");
		}
	}

	private createAppClient(): Octokit {
		return new Octokit({
			authStrategy: createAppAuth,
			auth: { appId: this.config.appId, privateKey: this.config.privateKey },
		});
	}

	private createInstallationClient(installationId: number): Octokit {
		return new Octokit({
			authStrategy: createAppAuth,
			auth: {
				appId: this.config.appId,
				privateKey: this.config.privateKey,
				installationId,
			},
		});
	}
}

function mapInstallationRow(row: typeof githubInstallations.$inferSelect): GitHubInstallationInfo {
	return {
		id: row.id,
		tenantId: row.tenantId,
		installationId: row.installationId,
		accountLogin: row.accountLogin,
		accountType: row.accountType as "Organization" | "User",
		repositorySelection: row.repositorySelection as "all" | "selected",
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}
