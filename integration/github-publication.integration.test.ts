import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { AesCryptoService } from "@procella/crypto";
import { githubUpdateOutbox, type Database, updates } from "@procella/db";
import {
	type GitHubDeliveryService,
	GitHubOutboxWorker,
	GITHUB_OUTBOX_MAX_ATTEMPTS,
	type GitHubInstallationInfo,
} from "@procella/github";
import { PostgresStacksService } from "@procella/stacks";
import { LocalBlobStorage } from "@procella/storage";
import type { Caller, EngineEvent } from "@procella/types";
import { GCWorker, PostgresUpdatesService } from "@procella/updates";
import { mkdtemp, rm } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { tmpdir } from "node:os";
import path from "node:path";
import { getTestDb, truncateTables } from "./setup.js";

let db: Database;
let stacksService!: PostgresStacksService;
let blobDir: string;
let updatesService!: PostgresUpdatesService;
let sequence = 0;

const caller: Caller = {
	tenantId: "tenant-1",
	orgSlug: "org-1",
	userId: "user-1",
	login: "octocat",
	roles: [],
	principalType: "user",
};

const environment = {
	"vcs.owner": "octocat",
	"vcs.repo": "infra",
	"ci.pr.number": "42",
	"ci.pr.headSHA": "abcdef1234567",
};

const installation: GitHubInstallationInfo = {
	id: "installation-row",
	tenantId: "tenant-1",
	installationId: 101,
	accountLogin: "octocat",
	accountType: "Organization",
	repositorySelection: "all",
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
};

interface DeliveryCalls {
	created: string[];
	found: string[];
	updated: Array<{ id: number; body: string }>;
	statuses: Array<{ state: string; context: string }>;
}

function fakeGitHub(options: {
	commentId?: number | null;
	installation?: GitHubInstallationInfo | null;
	onCreate?: () => Promise<void>;
	onStatus?: () => Promise<void>;
	resolveInstallation?: () => Promise<GitHubInstallationInfo | null>;
} = {}): { github: GitHubDeliveryService; calls: DeliveryCalls } {
	const calls: DeliveryCalls = { created: [], found: [], updated: [], statuses: [] };
	const github: GitHubDeliveryService = {
		resolveInstallation: mock(async () =>
			options.resolveInstallation
				? options.resolveInstallation()
				: options.installation === undefined
					? installation
					: options.installation,
		),
		createPRComment: mock(async (_installationId, _owner, _repo, _pr, body) => {
			calls.created.push(body);
			await options.onCreate?.();
			return 123;
		}),
		findPRComment: mock(async (_installationId, _owner, _repo, _pr, marker) => {
			calls.found.push(marker);
			return options.commentId ?? null;
		}),
		updatePRComment: mock(async (_installationId, _owner, _repo, id, body) => {
			calls.updated.push({ id, body });
		}),
		setCommitStatus: mock(async (_installationId, _owner, _repo, _sha, state, _description, context) => {
			await options.onStatus?.();
			calls.statuses.push({ state, context: context ?? "" });
		}),
	};
	return { github, calls };
}

async function createTargetedUpdate(options: { caller?: Caller; kind?: string } = {}) {
	sequence += 1;
	const stack = await stacksService.createStack(
		"tenant-1",
		"org-1",
		"infra",
		`stack-${sequence}`,
		{
			"vcs:owner": "octocat",
			"vcs:repo": "infra",
			"github:owner": "attacker",
			"github:repo": "other",
			"github:pr": "999",
			"github:sha": "bad",
		},
	);
	const created = await updatesService.createUpdate(
		stack.id,
		options.kind ?? "preview",
		undefined,
		undefined,
		options.caller ?? caller,
		environment,
	);
	return { stack, updateId: created.updateID };
}

function summary(sequenceNumber: number, create: number): EngineEvent {
	return {
		sequence: sequenceNumber,
		timestamp: sequenceNumber,
		summaryEvent: {
			maybeCorrupt: false,
			durationSeconds: 3,
			resourceChanges: { create },
			PolicyPacks: {},
			isPreview: true,
			result: "succeeded",
		},
	};
}

beforeAll(async () => {
	db = getTestDb();
	stacksService = new PostgresStacksService({ db });
	blobDir = await mkdtemp(path.join(tmpdir(), "procella-github-outbox-"));
	updatesService = new PostgresUpdatesService({
		db,
		storage: new LocalBlobStorage(blobDir),
		crypto: new AesCryptoService("a".repeat(64)),
	});
});

afterAll(async () => {
	await rm(blobDir, { recursive: true, force: true });
});

afterEach(async () => {
	await truncateTables();
});

describe("durable GitHub update publication", () => {
	test("snapshots metadata only after repository and workload validation", async () => {
		const accepted = await createTargetedUpdate();
		const [acceptedRow] = await db.select().from(updates).where(eq(updates.id, accepted.updateId));
		expect(acceptedRow.githubTarget).toMatchObject({
			owner: "octocat",
			repo: "infra",
			prNumber: 42,
			sha: "abcdef1234567",
		});

		const workload: Caller = {
			...caller,
			principalType: "workload",
			workload: {
				provider: "github",
				issuer: "https://token.actions.githubusercontent.com",
				subject: "repo:attacker/other:ref:refs/heads/main",
				repository: "attacker/other",
			},
		};
		const denied = await createTargetedUpdate({ caller: workload });
		const [deniedRow] = await db.select().from(updates).where(eq(updates.id, denied.updateId));
		expect(deniedRow.githubTarget).toBeNull();
	});

	test("atomically enqueues started and every terminal transition except never-started GC", async () => {
		for (const status of ["succeeded", "failed", "cancelled"] as const) {
			const { updateId } = await createTargetedUpdate();
			await updatesService.startUpdate(updateId, {});
			if (status === "cancelled") await updatesService.cancelUpdate(updateId);
			else await updatesService.completeUpdate(updateId, { status });
			const rows = await db
				.select({ phase: githubUpdateOutbox.phase })
				.from(githubUpdateOutbox)
				.where(eq(githubUpdateOutbox.updateId, updateId));
			expect(rows.map((row) => row.phase).sort()).toEqual(["started", "terminal"]);
			const delivery = fakeGitHub();
			const worker = new GitHubOutboxWorker({ db, github: delivery.github, maxPerRun: 2 });
			expect(await worker.runOnce()).toBe(2);
			expect(delivery.calls.statuses.map((entry) => entry.state)).toEqual([
				"pending",
				status === "succeeded" ? "success" : "failure",
			]);
			expect(delivery.calls.updated[0].body).toContain(`**Status:** ${status}`);
		}

		const stale = await createTargetedUpdate();
		await db
			.update(updates)
			.set({ status: "requested", createdAt: new Date(Date.now() - 7_200_000) })
			.where(eq(updates.id, stale.updateId));
		await new GCWorker({ db }).runOnce();
		const staleRows = await db
			.select()
			.from(githubUpdateOutbox)
			.where(eq(githubUpdateOutbox.updateId, stale.updateId));
		expect(staleRows).toHaveLength(0);
	});

	test("GC atomically enqueues cancellation only for expired running updates", async () => {
		const { updateId } = await createTargetedUpdate();
		await updatesService.startUpdate(updateId, {});
		await db
			.update(updates)
			.set({ leaseExpiresAt: new Date(Date.now() - 120_000) })
			.where(eq(updates.id, updateId));

		await new GCWorker({ db }).runOnce();
		const [row] = await db.select().from(updates).where(eq(updates.id, updateId));
		const outbox = await db
			.select()
			.from(githubUpdateOutbox)
			.where(eq(githubUpdateOutbox.updateId, updateId));
		expect(row.status).toBe("cancelled");
		expect(outbox.map((entry) => entry.phase).sort()).toEqual(["started", "terminal"]);
	});

	test("GC does not cancel a renewed lease or a requested update that became running", async () => {
		const renewed = await createTargetedUpdate();
		const renewedLease = await updatesService.startUpdate(renewed.updateId, {});
		if (!renewedLease.token) throw new Error("startUpdate did not return a lease token");
		await db
			.update(updates)
			.set({ leaseExpiresAt: new Date(Date.now() + 1_000) })
			.where(eq(updates.id, renewed.updateId));
		await updatesService.renewLease(renewed.updateId, {
			token: renewedLease.token,
			duration: 300,
		});

		const started = await createTargetedUpdate();
		await db
			.update(updates)
			.set({ status: "requested", createdAt: new Date(Date.now() - 7_200_000) })
			.where(eq(updates.id, started.updateId));
		await db
			.update(updates)
			.set({
				status: "running",
				leaseToken: "racing-start-token",
				leaseExpiresAt: new Date(Date.now() + 300_000),
				startedAt: new Date(),
			})
			.where(eq(updates.id, started.updateId));

		await new GCWorker({ db }).runOnce();
		const rows = await db
			.select({ id: updates.id, status: updates.status })
			.from(updates)
			.where(sql`${updates.id} IN (${renewed.updateId}, ${started.updateId})`);
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.status === "running")).toBe(true);
		const terminalRows = await db
			.select()
			.from(githubUpdateOutbox)
			.where(sql`${githubUpdateOutbox.updateId} IN (${renewed.updateId}, ${started.updateId}) AND ${githubUpdateOutbox.phase} = 'terminal'`);
		expect(terminalRows).toHaveLength(0);
	});

	test("does not derive a summary from a conflicting event replay", async () => {
		const { updateId } = await createTargetedUpdate();
		await updatesService.startUpdate(updateId, {});
		await updatesService.postEvents(updateId, {
			events: [{ sequence: 7, timestamp: 7, preludeEvent: { config: {} } }],
		});
		await updatesService.postEvents(updateId, { events: [summary(7, 99)] });

		const [row] = await db.select().from(updates).where(eq(updates.id, updateId));
		expect(row.summarySequence).toBeNull();
		expect(row.summary).toBeNull();

		const duplicate = await createTargetedUpdate();
		await updatesService.startUpdate(duplicate.updateId, {});
		await updatesService.postEvents(duplicate.updateId, {
			events: [
				{ sequence: 8, timestamp: 8, preludeEvent: { config: {} } },
				summary(8, 100),
			],
		});
		const [duplicateRow] = await db
			.select()
			.from(updates)
			.where(eq(updates.id, duplicate.updateId));
		expect(duplicateRow.summarySequence).toBeNull();
		expect(duplicateRow.summary).toBeNull();
	});

	test("keeps the exact highest-sequence summary and revises a delivered terminal", async () => {
		const { updateId } = await createTargetedUpdate();
		await updatesService.startUpdate(updateId, {});
		await updatesService.postEvents(updateId, { events: [summary(10, 3)] });
		await updatesService.postEvents(updateId, { events: [summary(9, 99), summary(10, 88)] });
		await updatesService.completeUpdate(updateId, { status: "succeeded" });

		const delivery = fakeGitHub();
		const worker = new GitHubOutboxWorker({ db, github: delivery.github, maxPerRun: 10 });
		expect(await worker.runOnce()).toBe(2);
		let [row] = await db.select().from(updates).where(eq(updates.id, updateId));
		expect(row.summarySequence).toBe(10);
		expect(row.summary).toEqual({
			maybeCorrupt: false,
			durationSeconds: 3,
			resourceChanges: { create: 3 },
			PolicyPacks: {},
			isPreview: true,
			result: "succeeded",
		});
		expect(delivery.calls.created).toHaveLength(1);
		expect(delivery.calls.updated).toHaveLength(1);
		expect(delivery.calls.updated[0].body).toContain("**Changes:** create 3");
		expect(delivery.calls.statuses.map((entry) => entry.state)).toEqual(["pending", "success"]);
		expect(new Set(delivery.calls.statuses.map((entry) => entry.context)).size).toBe(1);

		let terminal = (
			await db.select().from(githubUpdateOutbox).where(eq(githubUpdateOutbox.updateId, updateId))
		).find((entry) => entry.phase === "terminal");
		expect(terminal?.revision).toBe(1);
		expect(terminal?.deliveredRevision).toBe(1);

		await updatesService.postEvents(updateId, { events: [summary(11, 4)] });
		terminal = (
			await db.select().from(githubUpdateOutbox).where(eq(githubUpdateOutbox.updateId, updateId))
		).find((entry) => entry.phase === "terminal");
		expect(terminal?.revision).toBe(2);
		expect(terminal?.deliveredRevision).toBe(1);
		expect(await worker.runOnce()).toBe(1);
		[row] = await db.select().from(updates).where(eq(updates.id, updateId));
		expect(row.summarySequence).toBe(11);
		expect(delivery.calls.created).toHaveLength(1);
		expect(delivery.calls.updated.at(-1)?.body).toContain("**Changes:** create 4");
	});

	test("renders each update with only its own persisted summary", async () => {
		const first = await createTargetedUpdate();
		const second = await createTargetedUpdate();
		await updatesService.startUpdate(first.updateId, {});
		await updatesService.startUpdate(second.updateId, {});
		await updatesService.postEvents(first.updateId, { events: [summary(5, 1)] });
		await updatesService.postEvents(second.updateId, { events: [summary(8, 7)] });
		await updatesService.completeUpdate(first.updateId, { status: "succeeded" });
		await updatesService.completeUpdate(second.updateId, { status: "succeeded" });

		const delivery = fakeGitHub();
		const worker = new GitHubOutboxWorker({ db, github: delivery.github, maxPerRun: 4 });
		expect(await worker.runOnce()).toBe(4);
		const firstBody = delivery.calls.updated.find((call) =>
			call.body.includes(`/${first.stack.stackName}\``),
		)?.body;
		const secondBody = delivery.calls.updated.find((call) =>
			call.body.includes(`/${second.stack.stackName}\``),
		)?.body;
		expect(firstBody).toContain("**Changes:** create 1");
		expect(secondBody).toContain("**Changes:** create 7");
	});


	test("recovers a crash-before-save by marker and edits without creating a duplicate", async () => {
		const { updateId } = await createTargetedUpdate();
		await updatesService.startUpdate(updateId, {});
		const delivery = fakeGitHub({ commentId: 777 });
		const worker = new GitHubOutboxWorker({ db, github: delivery.github, maxPerRun: 1 });

		expect(await worker.runOnce()).toBe(1);
		const [row] = await db.select().from(updates).where(eq(updates.id, updateId));
		expect(delivery.calls.created).toHaveLength(0);
		expect(delivery.calls.updated).toEqual([
			expect.objectContaining({ id: 777, body: expect.stringContaining(`procella:update:${updateId}`) }),
		]);
		expect(row.githubCommentId).toBe("777");
	});

	test("denied repository resolution retries with a sanitized bounded delay", async () => {
		const { updateId } = await createTargetedUpdate();
		await updatesService.startUpdate(updateId, {});
		const delivery = fakeGitHub({ installation: null });
		const before = new Date();
		const worker = new GitHubOutboxWorker({ db, github: delivery.github, maxPerRun: 1 });

		expect(await worker.runOnce()).toBe(0);
		const [row] = await db
			.select()
			.from(githubUpdateOutbox)
			.where(eq(githubUpdateOutbox.updateId, updateId));
		expect(row.attempts).toBe(1);
		expect(row.availableAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + 4_000);
		expect(row.lastError).toBe("Error: No authorized GitHub App installation for repository");
		expect(delivery.calls.created).toHaveLength(0);
	});
	test("dead-letters a malformed summary and continues with later tenants", async () => {
		const poison = await createTargetedUpdate();
		await updatesService.startUpdate(poison.updateId, {});
		await expect(
			updatesService.postEvents(poison.updateId, {
				events: [{ sequence: 1, timestamp: 1, summaryEvent: "malformed-summary" } as never],
			}),
		).rejects.toThrow("Summary event must be an object");
		await updatesService.completeUpdate(poison.updateId, { status: "succeeded" });
		await db
			.update(githubUpdateOutbox)
			.set({ deliveredRevision: 1 })
			.where(
				sql`${githubUpdateOutbox.updateId} = ${poison.updateId} AND ${githubUpdateOutbox.phase} = 'started'`,
			);
		await db
			.update(updates)
			.set({ summary: "malformed-summary" as never })
			.where(eq(updates.id, poison.updateId));

		const healthy = await createTargetedUpdate();
		await updatesService.startUpdate(healthy.updateId, {});
		const delivery = fakeGitHub();
		const worker = new GitHubOutboxWorker({ db, github: delivery.github, maxPerRun: 2 });
		expect(await worker.runOnce()).toBe(1);

		const poisonRows = await db
			.select()
			.from(githubUpdateOutbox)
			.where(eq(githubUpdateOutbox.updateId, poison.updateId));
		const poisonTerminal = poisonRows.find((row) => row.phase === "terminal");
		expect(poisonTerminal?.failedRevision).toBe(1);
		expect(poisonTerminal?.failedAt).toBeInstanceOf(Date);
		expect(poisonTerminal?.lastError).toContain("Invalid update summary");
		const [healthyStarted] = await db
			.select()
			.from(githubUpdateOutbox)
			.where(eq(githubUpdateOutbox.updateId, healthy.updateId));
		expect(healthyStarted.deliveredRevision).toBe(1);
	});

	test("a permanently failed started phase does not block its terminal phase", async () => {
		const { updateId } = await createTargetedUpdate();
		await updatesService.startUpdate(updateId, {});
		await updatesService.completeUpdate(updateId, { status: "succeeded" });
		await db
			.update(githubUpdateOutbox)
			.set({ attempts: GITHUB_OUTBOX_MAX_ATTEMPTS - 1 })
			.where(
				sql`${githubUpdateOutbox.updateId} = ${updateId} AND ${githubUpdateOutbox.phase} = 'started'`,
			);
		let resolutions = 0;
		const delivery = fakeGitHub({
			resolveInstallation: async () => {
				resolutions += 1;
				return resolutions === 1 ? null : installation;
			},
		});
		const worker = new GitHubOutboxWorker({ db, github: delivery.github, maxPerRun: 2 });
		expect(await worker.runOnce()).toBe(1);
		const rows = await db
			.select()
			.from(githubUpdateOutbox)
			.where(eq(githubUpdateOutbox.updateId, updateId));
		const started = rows.find((row) => row.phase === "started");
		const terminal = rows.find((row) => row.phase === "terminal");
		expect(started?.attempts).toBe(GITHUB_OUTBOX_MAX_ATTEMPTS);
		expect(started?.failedRevision).toBe(1);
		expect(terminal?.deliveredRevision).toBe(1);
	});

	test("stale success and failure cannot acknowledge a newer summary revision", async () => {
		for (const failStatus of [false, true]) {
			const { updateId } = await createTargetedUpdate();
			await updatesService.startUpdate(updateId, {});
			await updatesService.completeUpdate(updateId, { status: "succeeded" });
			await db
				.update(githubUpdateOutbox)
				.set({ deliveredRevision: 1 })
				.where(
					sql`${githubUpdateOutbox.updateId} = ${updateId} AND ${githubUpdateOutbox.phase} = 'started'`,
				);
			await db
				.update(updates)
				.set({ githubCommentId: "123" })
				.where(eq(updates.id, updateId));

			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const staleDelivery = fakeGitHub({
				onStatus: async () => {
					entered.resolve();
					await release.promise;
					if (failStatus) throw new Error("stale failure");
				},
			});
			const staleWorker = new GitHubOutboxWorker({ db, github: staleDelivery.github, maxPerRun: 1 });
			const staleRun = staleWorker.runOnce();
			await entered.promise;
			await updatesService.postEvents(updateId, { events: [summary(20, 5)] });
			release.resolve();
			expect(await staleRun).toBe(0);

			let [terminal] = await db
				.select()
				.from(githubUpdateOutbox)
				.where(
					sql`${githubUpdateOutbox.updateId} = ${updateId} AND ${githubUpdateOutbox.phase} = 'terminal'`,
				);
			expect(terminal.revision).toBe(2);
			expect(terminal.deliveredRevision).toBe(0);
			expect(terminal.attempts).toBe(0);
			expect(terminal.claimedBy).toBeNull();
			expect(terminal.lastError).toBeNull();

			const currentWorker = new GitHubOutboxWorker({
				db,
				github: fakeGitHub().github,
				maxPerRun: 1,
			});
			expect(await currentWorker.runOnce()).toBe(1);
			[terminal] = await db
				.select()
				.from(githubUpdateOutbox)
				.where(
					sql`${githubUpdateOutbox.updateId} = ${updateId} AND ${githubUpdateOutbox.phase} = 'terminal'`,
				);
			expect(terminal.deliveredRevision).toBe(2);
		}
	});

	test("deadline-aware drain stops before claiming work that cannot fit", async () => {
		const first = await createTargetedUpdate();
		const second = await createTargetedUpdate();
		await updatesService.startUpdate(first.updateId, {});
		await updatesService.startUpdate(second.updateId, {});
		let now = 0;
		const delivery = fakeGitHub({
			onCreate: async () => {
				now = 10_000;
			},
		});
		const worker = new GitHubOutboxWorker({
			db,
			github: delivery.github,
			maxPerRun: 5,
			now: () => now,
		});
		expect(await worker.runOnce({ deadlineMs: 40_000 })).toBe(1);
		const rows = await db.select().from(githubUpdateOutbox);
		expect(rows.filter((row) => row.deliveredRevision === 1)).toHaveLength(1);
		expect(rows.filter((row) => row.deliveredRevision === 0)).toHaveLength(1);
	});


	test("expired claims are retried and concurrent workers do not overlap", async () => {
		const { updateId } = await createTargetedUpdate();
		await updatesService.startUpdate(updateId, {});
		await db
			.update(githubUpdateOutbox)
			.set({
				claimedBy: "11111111-1111-4111-8111-111111111111",
				claimedUntil: new Date(Date.now() - 1_000),
				availableAt: sql`now()`,
			})
			.where(eq(githubUpdateOutbox.updateId, updateId));

		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const delivery = fakeGitHub({
			onCreate: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		const first = new GitHubOutboxWorker({ db, github: delivery.github, maxPerRun: 1 });
		const second = new GitHubOutboxWorker({ db, github: delivery.github, maxPerRun: 1 });
		const firstRun = first.runOnce();
		await entered.promise;
		expect(await second.runOnce()).toBe(0);
		release.resolve();
		expect(await firstRun).toBe(1);
		expect(delivery.calls.created).toHaveLength(1);
	});

	test("long-lived worker performs an immediate drain and stops cleanly", async () => {
		const { updateId } = await createTargetedUpdate();
		await updatesService.startUpdate(updateId, {});
		const delivery = fakeGitHub();
		const worker = new GitHubOutboxWorker({
			db,
			github: delivery.github,
			interval: 60_000,
			maxPerRun: 1,
		});

		await worker.start();
		await worker.stop();
		expect(delivery.calls.created).toHaveLength(1);
	});
});
