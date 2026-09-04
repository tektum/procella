import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Config } from "@procella/config";
import type { Database } from "@procella/db";
import { githubInstallations, githubSetupStates, githubUpdateOutbox, updates } from "@procella/db";
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
	privateKey: string;
	webhookSecret: string;
	stateSigningKey: string;
}

export interface GitHubDeliveryConfig {
	appId: string;
	privateKey: string;
}

export interface GitHubRepositoryTarget {
	tenantId: string;
	owner: string;
	repo: string;
}

export interface GitHubDeliveryService {
	resolveInstallation(target: GitHubRepositoryTarget): Promise<GitHubInstallationInfo | null>;
	createPRComment(
		installationId: number,
		owner: string,
		repo: string,
		prNumber: number,
		body: string,
	): Promise<number>;
	findPRComment(
		installationId: number,
		owner: string,
		repo: string,
		prNumber: number,
		marker: string,
	): Promise<number | null>;
	updatePRComment(
		installationId: number,
		owner: string,
		repo: string,
		commentId: number,
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

export interface GitHubService extends GitHubDeliveryService {
	handleWebhookEvent(event: string, payload: unknown): Promise<void>;
	issueInstallationUrl(tenantId: string): Promise<string>;
	completeInstallation(state: string, installationId: number): Promise<GitHubInstallationInfo>;
	listInstallations(tenantId: string): Promise<GitHubInstallationInfo[]>;
	removeInstallation(tenantId: string, installationId: number): Promise<void>;
}

export const GITHUB_SETUP_STATE_TTL_SECONDS = 10 * 60;
const GITHUB_SETUP_STATE_ISSUER = "procella";
const GITHUB_SETUP_STATE_AUDIENCE = "procella:github-app-installation";
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

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
		!config.githubAppPrivateKey ||
		!config.githubAppWebhookSecret ||
		!config.ticketSigningKey
	) {
		return null;
	}

	return {
		appId: config.githubAppId,
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
	updateId: string;
	org: string;
	project: string;
	stack: string;
	kind: string;
	status: string;
	resourceChanges?: Record<string, number>;
	permalink?: string;
}): string {
	const title = update.kind === "preview" ? "Pulumi Preview" : "Pulumi Update";
	const statusLabel = update.status === "running" ? "in progress" : update.status;
	const lines = [
		`<!-- procella:update:${update.updateId} -->`,
		`## ${title}`,
		`**Stack:** \`${update.org}/${update.project}/${update.stack}\``,
		`**Status:** ${statusLabel}`,
	];

	if (update.status !== "running") {
		if (update.resourceChanges) {
			const changes = Object.entries(update.resourceChanges)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([operation, count]) => `${operation} ${count}`);
			lines.push(`**Changes:** ${changes.length > 0 ? changes.join(", ") : "none"}`);
		} else {
			lines.push("**Summary:** unavailable");
		}
	}

	if (update.permalink) lines.push("", `[View details](${update.permalink})`);
	return lines.join("\n");
}

export function buildCommitStatusContext(update: {
	org: string;
	project: string;
	stack: string;
}): string {
	const context = `procella/${update.org}/${update.project}/${update.stack}`;
	if (context.length <= 100) return context;
	const suffix = createHash("sha256").update(context).digest("hex").slice(0, 8);
	return `${context.slice(0, 91)}-${suffix}`;
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

/** GitHub client used by background delivery workers. It needs only App signing credentials. */
export class OctokitGitHubDeliveryService implements GitHubDeliveryService {
	protected readonly db: Database;
	protected readonly appClient: Octokit;
	protected readonly installationClientFactory: (installationId: number) => Octokit;

	constructor({
		db,
		config,
		appClient,
		installationClientFactory,
	}: {
		db: Database;
		config: GitHubDeliveryConfig;
		appClient?: Octokit;
		installationClientFactory?: (installationId: number) => Octokit;
	}) {
		this.db = db;
		this.appClient =
			appClient ??
			new Octokit({
				authStrategy: createAppAuth,
				auth: { appId: config.appId, privateKey: config.privateKey },
				request: { timeout: GITHUB_REQUEST_TIMEOUT_MS },
			});
		this.installationClientFactory =
			installationClientFactory ??
			((installationId) =>
				new Octokit({
					authStrategy: createAppAuth,
					auth: { appId: config.appId, privateKey: config.privateKey, installationId },
					request: { timeout: GITHUB_REQUEST_TIMEOUT_MS },
				}));
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
		const rows = await this.db
			.select()
			.from(githubInstallations)
			.where(eq(githubInstallations.tenantId, target.tenantId))
			.orderBy(desc(githubInstallations.updatedAt));
		try {
			const { data } = await this.appClient.request("GET /repos/{owner}/{repo}/installation", {
				owner: target.owner,
				repo: target.repo,
			});
			if (!Number.isSafeInteger(data.id)) return null;
			const row = rows.find((installation) => installation.installationId === data.id);
			return row ? mapInstallationRow(row) : null;
		} catch {
			return null;
		}
	}

	async createPRComment(
		installationId: number,
		owner: string,
		repo: string,
		prNumber: number,
		body: string,
	): Promise<number> {
		const { data } = await this.installationClientFactory(installationId).rest.issues.createComment(
			{ owner, repo, issue_number: prNumber, body },
		);
		if (!Number.isSafeInteger(data.id)) throw new Error("GitHub returned an invalid comment ID");
		return data.id;
	}

	async findPRComment(
		installationId: number,
		owner: string,
		repo: string,
		prNumber: number,
		marker: string,
	): Promise<number | null> {
		const octokit = this.installationClientFactory(installationId);
		const comments = await octokit.paginate(octokit.rest.issues.listComments, {
			owner,
			repo,
			issue_number: prNumber,
			per_page: 100,
		});
		const match = comments.find((comment) => comment.body?.includes(marker));
		return match && Number.isSafeInteger(match.id) ? match.id : null;
	}

	async updatePRComment(
		installationId: number,
		owner: string,
		repo: string,
		commentId: number,
		body: string,
	): Promise<void> {
		await this.installationClientFactory(installationId).rest.issues.updateComment({
			owner,
			repo,
			comment_id: commentId,
			body,
		});
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
		await this.installationClientFactory(installationId).rest.repos.createCommitStatus({
			owner,
			repo,
			sha,
			state,
			description,
			context,
		});
	}
}
export class OctokitGitHubService extends OctokitGitHubDeliveryService implements GitHubService {
	private readonly config: GitHubAppConfig;
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
		super({ db, config, appClient, installationClientFactory });
		this.config = config;
		this.setupStates = setupStates ?? createGitHubSetupStateService(config.stateSigningKey);
	}

	async issueInstallationUrl(tenantId: string): Promise<string> {
		const slug = await this.loadAppSlug();
		const { state, claims } = await this.setupStates.issue(tenantId);
		await this.db.delete(githubSetupStates).where(lt(githubSetupStates.expiresAt, sql`now()`));
		await this.db.insert(githubSetupStates).values({
			jti: claims.jti,
			tenantId: claims.tenantId,
			expiresAt: claims.expiresAt,
		});

		const url = new URL(`https://github.com/apps/${slug}/installations/new`);
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
	private async loadAppSlug(): Promise<string> {
		try {
			const { data } = await this.appClient.request("GET /app");
			if (
				!data ||
				data.id !== Number(this.config.appId) ||
				typeof data.slug !== "string" ||
				!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(data.slug)
			) {
				throw new Error("GitHub App identity did not match configured credentials");
			}
			return data.slug;
		} catch {
			throw new Error("Unable to verify configured GitHub App");
		}
	}
}

export const GITHUB_OUTBOX_CLAIM_SECONDS = 120;
export const GITHUB_OUTBOX_MAX_ATTEMPTS_PER_RUN = 25;
export const GITHUB_OUTBOX_POLL_INTERVAL_MS = 5_000;

interface GitHubPublicationTarget {
	tenantId: string;
	owner: string;
	repo: string;
	prNumber: number;
	sha: string;
	org: string;
	project: string;
	stack: string;
}

interface GitHubOutboxClaim {
	id: string;
	updateId: string;
	phase: "started" | "terminal";
	revision: number;
	attempts: number;
	target: GitHubPublicationTarget;
	commentId: string | null;
	kind: string;
	status: string;
	summary: Record<string, unknown> | null;
}

interface RawGitHubOutboxClaim extends Omit<GitHubOutboxClaim, "target" | "summary"> {
	target: unknown;
	summary: unknown;
}

export class GitHubOutboxWorker {
	private readonly db: Database;
	private readonly github: GitHubDeliveryService;
	private readonly interval: number;
	private readonly maxPerRun: number;
	private readonly workerId: string;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	constructor({
		db,
		github,
		interval,
		maxPerRun,
		workerId,
	}: {
		db: Database;
		github: GitHubDeliveryService;
		interval?: number;
		maxPerRun?: number;
		workerId?: string;
	}) {
		this.db = db;
		this.github = github;
		this.interval = interval ?? GITHUB_OUTBOX_POLL_INTERVAL_MS;
		this.maxPerRun = maxPerRun ?? GITHUB_OUTBOX_MAX_ATTEMPTS_PER_RUN;
		this.workerId = workerId ?? randomUUID();
	}

	async start(): Promise<void> {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.runCycle().catch((error) => console.error("[github-outbox] cycle failed", error));
		}, this.interval);
		await this.runCycle().catch((error) => console.error("[github-outbox] cycle failed", error));
	}
	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		while (this.running) await Bun.sleep(25);
	}

	/** Drain at most one bounded batch. Intended for scheduled and Lambda invocations. */
	async runOnce(): Promise<number> {
		return this.runCycle();
	}

	private async runCycle(): Promise<number> {
		if (this.running) return 0;
		this.running = true;
		let delivered = 0;
		try {
			for (let index = 0; index < this.maxPerRun; index += 1) {
				const claim = await this.claimNext();
				if (!claim) break;
				try {
					await this.deliver(claim);
					await this.ack(claim);
					delivered += 1;
				} catch (error) {
					await this.retry(claim, error);
				}
			}
			return delivered;
		} finally {
			this.running = false;
		}
	}

	private async claimNext(): Promise<GitHubOutboxClaim | null> {
		return this.db.transaction(async (tx) => {
			const result = await tx.execute(sql`
				WITH candidate AS (
					SELECT outbox.id
					FROM github_update_outbox outbox
					WHERE outbox.delivered_revision < outbox.revision
						AND outbox.available_at <= now()
						AND (outbox.claimed_until IS NULL OR outbox.claimed_until < now())
						AND (
							outbox.phase = 'started'
							OR NOT EXISTS (
								SELECT 1 FROM github_update_outbox started
								WHERE started.update_id = outbox.update_id
									AND started.phase = 'started'
									AND started.delivered_revision < started.revision
							)
						)
					ORDER BY outbox.created_at, CASE outbox.phase WHEN 'started' THEN 0 ELSE 1 END
					FOR UPDATE SKIP LOCKED
					LIMIT 1
				), claimed AS (
					UPDATE github_update_outbox outbox
					SET claimed_by = ${this.workerId}::uuid,
						claimed_until = now() + (${GITHUB_OUTBOX_CLAIM_SECONDS} * interval '1 second'),
						attempts = outbox.attempts + 1,
						updated_at = now()
					FROM candidate
					WHERE outbox.id = candidate.id
					RETURNING outbox.*
				)
				SELECT claimed.id, claimed.update_id AS "updateId", claimed.phase,
					claimed.revision, claimed.attempts, source_update.github_target AS target,
					source_update.github_comment_id AS "commentId", source_update.kind,
					source_update.status, source_update.summary
				FROM claimed
				JOIN updates source_update ON source_update.id = claimed.update_id
			`);
			const row = readExecuteRows<RawGitHubOutboxClaim>(result)[0];
			if (!row) return null;
			return {
				...row,
				target: parseGitHubPublicationTarget(row.target),
				summary: row.summary === null ? null : parseJsonRecord(row.summary, "update summary"),
			};
		});
	}

	private async deliver(claim: GitHubOutboxClaim): Promise<void> {
		const { target } = claim;
		const installation = await this.github.resolveInstallation(target);
		if (!installation) throw new Error("No authorized GitHub App installation for repository");
		await this.renewClaim(claim);

		const marker = `<!-- procella:update:${claim.updateId} -->`;
		const body = buildPRCommentBody({
			updateId: claim.updateId,
			org: target.org,
			project: target.project,
			stack: target.stack,
			kind: claim.kind,
			status: claim.phase === "started" ? "running" : claim.status,
			resourceChanges:
				claim.phase === "terminal" ? resourceChangesFromSummary(claim.summary) : undefined,
		});

		let commentId = parseGitHubCommentId(claim.commentId);
		if (commentId === null) {
			commentId = await this.github.findPRComment(
				installation.installationId,
				target.owner,
				target.repo,
				target.prNumber,
				marker,
			);
		}
		await this.renewClaim(claim);
		if (commentId === null) {
			commentId = await this.github.createPRComment(
				installation.installationId,
				target.owner,
				target.repo,
				target.prNumber,
				body,
			);
		} else {
			await this.github.updatePRComment(
				installation.installationId,
				target.owner,
				target.repo,
				commentId,
				body,
			);
		}
		if (claim.commentId === null) await this.persistCommentId(claim, commentId);

		const status = claim.phase === "started" ? "running" : claim.status;
		await this.github.setCommitStatus(
			installation.installationId,
			target.owner,
			target.repo,
			target.sha,
			mapUpdateStatusToCommitState(status),
			`Procella ${claim.kind} ${status === "running" ? "in progress" : status}`,
			buildCommitStatusContext(target),
		);
	}

	private async renewClaim(claim: GitHubOutboxClaim): Promise<void> {
		const rows = await this.db
			.update(githubUpdateOutbox)
			.set({
				claimedUntil: sql`now() + (${GITHUB_OUTBOX_CLAIM_SECONDS} * interval '1 second')`,
				updatedAt: sql`now()`,
			})
			.where(
				and(eq(githubUpdateOutbox.id, claim.id), eq(githubUpdateOutbox.claimedBy, this.workerId)),
			)
			.returning({ id: githubUpdateOutbox.id });
		if (rows.length === 0) throw new Error("GitHub outbox claim lease lost");
	}

	private async persistCommentId(claim: GitHubOutboxClaim, commentId: number): Promise<void> {
		const rows = await this.db.transaction(async (tx) => {
			const owned = await tx
				.update(githubUpdateOutbox)
				.set({
					claimedUntil: sql`now() + (${GITHUB_OUTBOX_CLAIM_SECONDS} * interval '1 second')`,
					updatedAt: sql`now()`,
				})
				.where(
					and(eq(githubUpdateOutbox.id, claim.id), eq(githubUpdateOutbox.claimedBy, this.workerId)),
				)
				.returning({ id: githubUpdateOutbox.id });
			if (owned.length === 0) return [];
			return tx
				.update(updates)
				.set({ githubCommentId: String(commentId), updatedAt: sql`now()` })
				.where(and(eq(updates.id, claim.updateId), sql`${updates.githubCommentId} IS NULL`))
				.returning({ id: updates.id });
		});
		if (rows.length === 0) throw new Error("GitHub outbox claim lease lost");
	}

	private async ack(claim: GitHubOutboxClaim): Promise<void> {
		await this.db
			.update(githubUpdateOutbox)
			.set({
				deliveredRevision: claim.revision,
				attempts: 0,
				claimedBy: null,
				claimedUntil: null,
				lastError: null,
				availableAt: sql`now()`,
				updatedAt: sql`now()`,
			})
			.where(
				and(eq(githubUpdateOutbox.id, claim.id), eq(githubUpdateOutbox.claimedBy, this.workerId)),
			);
	}

	private async retry(claim: GitHubOutboxClaim, error: unknown): Promise<void> {
		const delaySeconds = githubRetryDelaySeconds(claim.attempts);
		await this.db
			.update(githubUpdateOutbox)
			.set({
				claimedBy: null,
				claimedUntil: null,
				availableAt: sql`now() + (${delaySeconds} * interval '1 second')`,
				lastError: sanitizeDeliveryError(error),
				updatedAt: sql`now()`,
			})
			.where(
				and(eq(githubUpdateOutbox.id, claim.id), eq(githubUpdateOutbox.claimedBy, this.workerId)),
			);
	}
}

function parseJsonRecord(value: unknown, label: string): Record<string, unknown> {
	const parsed = typeof value === "string" ? JSON.parse(value) : value;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid ${label} in PostgreSQL`);
	}
	return parsed as Record<string, unknown>;
}

function parseGitHubPublicationTarget(value: unknown): GitHubPublicationTarget {
	const target = parseJsonRecord(value, "GitHub publication target");
	if (
		typeof target.tenantId !== "string" ||
		typeof target.owner !== "string" ||
		typeof target.repo !== "string" ||
		typeof target.prNumber !== "number" ||
		!Number.isSafeInteger(target.prNumber) ||
		typeof target.sha !== "string" ||
		typeof target.org !== "string" ||
		typeof target.project !== "string" ||
		typeof target.stack !== "string"
	) {
		throw new Error("Invalid GitHub publication target in PostgreSQL");
	}
	return target as unknown as GitHubPublicationTarget;
}

function resourceChangesFromSummary(
	summary: Record<string, unknown> | null,
): Record<string, number> | undefined {
	const changes = summary?.resourceChanges;
	if (!changes || typeof changes !== "object" || Array.isArray(changes)) return undefined;
	return Object.fromEntries(
		Object.entries(changes).filter(
			(entry): entry is [string, number] =>
				typeof entry[1] === "number" && Number.isFinite(entry[1]),
		),
	);
}

function parseGitHubCommentId(value: string | null): number | null {
	if (!value || !/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

export function githubRetryDelaySeconds(attempts: number): number {
	return Math.min(900, 5 * 2 ** Math.min(Math.max(attempts - 1, 0), 8));
}

export function sanitizeDeliveryError(error: unknown): string {
	const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return message
		.replace(/authorization["']?\s*[:=]\s*[^\r\n,}]+/gi, "authorization=[redacted]")
		.replace(/(token|secret|private[-_ ]?key)["']?\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[redacted]")
		.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1[redacted]@")
		.slice(0, 500);
}

function readExecuteRows<T>(result: unknown): T[] {
	if (Array.isArray(result)) return result as T[];
	if (typeof result === "object" && result !== null && "rows" in result) {
		const rows = result.rows;
		if (Array.isArray(rows)) return rows as T[];
	}
	throw new Error("Unexpected database execute result shape");
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
