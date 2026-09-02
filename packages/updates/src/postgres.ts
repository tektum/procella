// @procella/updates — PostgreSQL implementation of UpdatesService.

import type { CryptoService, StackCryptoInput } from "@procella/crypto";
import type { Database } from "@procella/db";
import { checkpoints, journalEntries, stacks, updateEvents, updates } from "@procella/db";
import type { BlobStorage } from "@procella/storage";

import {
	activeUpdatesGauge,
	checkpointSizeHistogram,
	journalEntriesCount,
	withDbSpan,
} from "@procella/telemetry";
import type {
	Caller,
	CompleteUpdateRequest,
	EngineEvent,
	EngineEventBatch,
	GetHistoryResponse,
	GetUpdateEventsResponse,
	ImportStackResponse,
	JournalEntries,
	JournalEntry,
	OperationV2,
	PatchUpdateCheckpointDeltaRequest,
	PatchUpdateCheckpointRequest,
	PatchUpdateVerbatimCheckpointRequest,
	RenewUpdateLeaseRequest,
	RenewUpdateLeaseResponse,
	ResourceV3,
	StartUpdateRequest,
	StartUpdateResponse,
	UntypedDeployment,
	UpdateInfo,
	UpdateProgramResponse,
	UpdateResults,
	UpdateStatus,
} from "@procella/types";
import {
	BadRequestError,
	CheckpointNotFoundError,
	JournalEntryBegin,
	JournalEntryFailure,
	JournalEntryOutputs,
	JournalEntryRebuiltBaseState,
	JournalEntryRefreshSuccess,
	JournalEntrySecretsManager,
	JournalEntrySuccess,
	JournalEntryWrite,
	LeaseExpiredError,
	UnauthorizedError,
	UpdateConflictError,
	UpdateNotFoundError,
} from "@procella/types";
import { and, desc, eq, gt, max, ne, sql } from "drizzle-orm";
import type { TextEdit } from "./helpers.js";
import {
	applyTextEdits,
	emptyDeployment,
	formatBlobKey,
	generateLeaseToken,
	leaseExpiresAt,
	safeTokenCompare,
} from "./helpers.js";
import type { CompletedUpdate, UpdatesService } from "./types.js";
import { BLOB_THRESHOLD, ImportConflictError, LEASE_DURATION_SECONDS } from "./types.js";

const MAX_JOURNAL_ENTRIES = 10_000;
const MAX_EVENT_BATCH_SIZE = 1_000;

type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

interface LockedUpdateRow {
	stackId: string;
	status: string;
	leaseToken: string | null;
	leaseExpiresAt: Date | null;
}

interface StackLockRow {
	activeUpdateId: string | null;
}

interface NextCheckpointVersionRow {
	nextVersion: number | string | bigint;
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

// ============================================================================
// PostgresUpdatesService
// ============================================================================

export class PostgresUpdatesService implements UpdatesService {
	private readonly db: Database;
	private readonly storage: BlobStorage;
	private readonly crypto: CryptoService;

	// Per-update caches for immutable/monotonic data. Cleared on completeUpdate/cancelUpdate.
	// Journal entries are NOT cached — DB remains source of truth for cluster safety.
	private readonly baseDeploymentCache = new Map<string, Record<string, unknown>>();

	constructor({
		db,
		storage,
		crypto,
	}: { db: Database; storage: BlobStorage; crypto: CryptoService }) {
		this.db = db;
		this.storage = storage;
		this.crypto = crypto;
	}

	// ========================================================================
	// T8.2 — Core Lifecycle Methods
	// ========================================================================

	async createUpdate(
		stackId: string,
		kind: string,
		config?: unknown,
		program?: unknown,
		caller?: Caller,
		environment?: Record<string, string>,
	): Promise<UpdateProgramResponse> {
		return withDbSpan("createUpdate", { "update.kind": kind, "stack.id": stackId }, async () => {
			const [versionRow] = await this.db
				.select({ maxVersion: max(checkpoints.version) })
				.from(checkpoints)
				.where(eq(checkpoints.stackId, stackId));

			const version = (versionRow?.maxVersion ?? 0) + 1;

			try {
				const [row] = await this.db
					.insert(updates)
					.values({
						stackId,
						kind,
						status: "not started",
						version,
						config: config ?? null,
						program: program ?? null,
						environment: environment ?? {},
						initiatedBy: caller?.userId || null, // use || so empty string becomes null
						initiatedByType: caller?.principalType ?? null,
						initiatedByDisplay: caller?.login ?? null,
						initiatedByMeta: caller?.workload
							? (caller.workload as unknown as Record<string, unknown>)
							: null,
					})
					.returning();

				this.db.execute(sql`SELECT pg_notify('stack_updates', ${stackId})`).catch(() => {});

				return { updateID: row.id, version } as UpdateProgramResponse;
			} catch (err: unknown) {
				if (pgErrorCode(err) === "23505") {
					throw new UpdateConflictError(
						"Another update is already in progress for this stack. Run `pulumi cancel` to cancel it first.",
					);
				}
				throw err;
			}
		});
	}

	async startUpdate(updateId: string, request: StartUpdateRequest): Promise<StartUpdateResponse> {
		return withDbSpan("startUpdate", { "update.id": updateId }, async () => {
			let notifyStackId: string | undefined;
			const result = await this.db.transaction(async (tx) => {
				const [row] = await tx.select().from(updates).where(eq(updates.id, updateId));

				if (!row) {
					throw new UpdateNotFoundError(updateId);
				}

				if (row.status !== "not started") {
					throw new UpdateConflictError(
						`Update ${updateId} is in status "${row.status}", expected "not started"`,
					);
				}

				notifyStackId = row.stackId;
				const token = generateLeaseToken(updateId, row.stackId);
				const expiry = leaseExpiresAt();

				await tx
					.update(updates)
					.set({
						status: "running",
						leaseToken: token,
						leaseExpiresAt: expiry,
						startedAt: sql`now()`,
						updatedAt: sql`now()`,
					})
					.where(eq(updates.id, updateId));

				await tx
					.update(stacks)
					.set({ activeUpdateId: updateId, updatedAt: sql`now()` })
					.where(eq(stacks.id, row.stackId));

				const journalVersion = (request.journalVersion ?? 0) >= 1 ? 1 : 0;

				return {
					token,
					version: row.version,
					tokenExpiration: Math.floor(expiry.getTime() / 1000),
					...(journalVersion > 0 ? { journalVersion } : {}),
				} as StartUpdateResponse;
			});
			activeUpdatesGauge().add(1);
			if (notifyStackId)
				this.db.execute(sql`SELECT pg_notify('stack_updates', ${notifyStackId})`).catch(() => {});
			return result;
		});
	}

	async verifyUpdateOwnership(updateId: string, stackId: string): Promise<void> {
		return withDbSpan("verifyUpdateOwnership", { "update.id": updateId }, async () => {
			const [row] = await this.db
				.select({ stackId: updates.stackId })
				.from(updates)
				.where(eq(updates.id, updateId));

			if (!row || row.stackId !== stackId) {
				throw new UpdateNotFoundError(updateId);
			}
		});
	}

	async verifyLeaseToken(updateId: string, token: string): Promise<void> {
		return withDbSpan("verifyLeaseToken", { "update.id": updateId }, async () => {
			const [row] = await this.db
				.select({ leaseToken: updates.leaseToken, leaseExpiresAt: updates.leaseExpiresAt })
				.from(updates)
				.where(eq(updates.id, updateId));

			if (!row?.leaseToken) {
				throw new UnauthorizedError("Invalid or expired update token");
			}

			if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() < Date.now()) {
				throw new UnauthorizedError("Update lease has expired");
			}

			if (!safeTokenCompare(row.leaseToken, token)) {
				throw new UnauthorizedError("Invalid update token");
			}
		});
	}

	async completeUpdate(updateId: string, request: CompleteUpdateRequest): Promise<void> {
		let notifyStackId: string | undefined;
		await withDbSpan(
			"completeUpdate",
			{ "update.id": updateId, "update.status": request.status },
			() =>
				this.db.transaction(async (tx) => {
					const [row] = await tx.select().from(updates).where(eq(updates.id, updateId));

					if (!row) {
						throw new UpdateNotFoundError(updateId);
					}

					if (row.status !== "running") {
						throw new UpdateConflictError(
							`Update ${updateId} is in status "${row.status}", expected "running"`,
						);
					}

					notifyStackId = row.stackId;

					await tx
						.update(updates)
						.set({
							status: request.status,
							result: request.status,
							completedAt: sql`now()`,
							leaseToken: null,
							leaseExpiresAt: null,
							updatedAt: sql`now()`,
						})
						.where(eq(updates.id, updateId));

					await tx
						.update(stacks)
						.set({ activeUpdateId: null, updatedAt: sql`now()` })
						.where(eq(stacks.id, row.stackId));
				}),
		);

		activeUpdatesGauge().add(-1);
		this.clearUpdateCaches(updateId);
		if (notifyStackId)
			this.db.execute(sql`SELECT pg_notify('stack_updates', ${notifyStackId})`).catch(() => {});
	}

	async getUpdateContext(updateId: string): Promise<CompletedUpdate> {
		return withDbSpan("getUpdateContext", { "update.id": updateId }, async () => {
			const [row] = await this.db
				.select({ stackId: updates.stackId, environment: updates.environment })
				.from(updates)
				.where(eq(updates.id, updateId));

			if (!row) {
				throw new UpdateNotFoundError(updateId);
			}

			return { stackId: row.stackId, environment: row.environment };
		});
	}

	async cancelUpdate(updateId: string): Promise<void> {
		let notifyStackId: string | undefined;
		const wasRunning = await withDbSpan("cancelUpdate", { "update.id": updateId }, () =>
			this.db.transaction(async (tx) => {
				const [row] = await tx.select().from(updates).where(eq(updates.id, updateId));

				if (!row) {
					throw new UpdateNotFoundError(updateId);
				}

				if (row.status === "cancelled" || row.status === "succeeded" || row.status === "failed") {
					return false;
				}

				notifyStackId = row.stackId;
				const previouslyRunning = row.status === "running";

				await tx
					.update(updates)
					.set({
						status: "cancelled",
						leaseToken: null,
						leaseExpiresAt: null,
						completedAt: sql`now()`,
						updatedAt: sql`now()`,
					})
					.where(eq(updates.id, updateId));

				await tx
					.update(stacks)
					.set({ activeUpdateId: null, updatedAt: sql`now()` })
					.where(eq(stacks.id, row.stackId));

				return previouslyRunning;
			}),
		);

		if (wasRunning) {
			activeUpdatesGauge().add(-1);
		}
		this.clearUpdateCaches(updateId);
		if (notifyStackId)
			this.db.execute(sql`SELECT pg_notify('stack_updates', ${notifyStackId})`).catch(() => {});
	}

	async getUpdate(updateId: string): Promise<UpdateResults> {
		return withDbSpan("getUpdate", { "update.id": updateId }, async () => {
			const [row] = await this.db.select().from(updates).where(eq(updates.id, updateId));

			if (!row) {
				throw new UpdateNotFoundError(updateId);
			}

			return {
				status: mapStatusToApiStatus(row.status) as UpdateStatus,
				events: [],
				continuationToken: undefined,
			} satisfies UpdateResults;
		});
	}

	async getHistory(stackId: string): Promise<GetHistoryResponse> {
		return withDbSpan("getHistory", { "stack.id": stackId }, async () => {
			const rows = await this.db
				.select()
				.from(updates)
				.where(eq(updates.stackId, stackId))
				.orderBy(desc(updates.createdAt));

			const updateList: UpdateInfo[] = rows.map(
				(row) =>
					({
						updateID: row.id,
						kind: row.kind,
						startTime: row.startedAt ? Math.floor(row.startedAt.getTime() / 1000) : 0,
						endTime: row.completedAt ? Math.floor(row.completedAt.getTime() / 1000) : 0,
						version: row.version ?? 0,
						message: row.message ?? "",
						result: row.result ?? "",
						environment: {},
						config: (row.config ?? {}) as Record<string, unknown>,
						resourceChanges: {},
					}) as unknown as UpdateInfo,
			);

			return { updates: updateList } as GetHistoryResponse;
		});
	}

	// ========================================================================
	// T8.3 — Checkpoint, Event, and Lease Methods
	// ========================================================================

	async patchCheckpoint(updateId: string, request: PatchUpdateCheckpointRequest): Promise<void> {
		return withDbSpan("patchCheckpoint", { "update.id": updateId }, async () => {
			const deployment = (request as { deployment?: unknown }).deployment;
			await this.upsertCheckpoint(updateId, deployment);
		});
	}

	async patchCheckpointVerbatim(
		updateId: string,
		request: PatchUpdateVerbatimCheckpointRequest,
	): Promise<void> {
		return withDbSpan("patchCheckpointVerbatim", { "update.id": updateId }, async () => {
			const wrapper = (request as { untypedDeployment?: { deployment?: unknown } })
				.untypedDeployment;
			const rawDeployment = wrapper?.deployment ?? wrapper;
			await this.upsertCheckpoint(updateId, rawDeployment);
		});
	}

	async patchCheckpointDelta(
		updateId: string,
		request: PatchUpdateCheckpointDeltaRequest,
	): Promise<void> {
		return withDbSpan("patchCheckpointDelta", { "update.id": updateId }, async () => {
			// Fetch latest non-delta checkpoint for this update
			const [baseCheckpoint] = await this.db
				.select()
				.from(checkpoints)
				.where(and(eq(checkpoints.updateId, updateId), eq(checkpoints.isDelta, false)))
				.orderBy(desc(checkpoints.version))
				.limit(1);

			let baseDeployment: unknown;
			if (baseCheckpoint) {
				if (baseCheckpoint.blobKey) {
					const data = await this.storage.get(baseCheckpoint.blobKey);
					if (!data) {
						throw new Error("Checkpoint blob data missing from storage");
					}
					baseDeployment = JSON.parse(new TextDecoder().decode(data));
				} else {
					baseDeployment = baseCheckpoint.data;
				}
			} else {
				baseDeployment = {};
			}

			const baseJson = JSON.stringify(baseDeployment);

			const edits = (request as { deploymentDelta?: unknown }).deploymentDelta;
			if (!Array.isArray(edits)) {
				throw new BadRequestError("deploymentDelta must be an array of TextEdit");
			}

			const newJson = applyTextEdits(baseJson, edits as TextEdit[]);

			const expectedHash = (request as { checkpointHash?: string }).checkpointHash;
			if (expectedHash) {
				const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(newJson));
				const actualHash = Array.from(new Uint8Array(hashBuffer))
					.map((b) => b.toString(16).padStart(2, "0"))
					.join("");
				if (actualHash !== expectedHash) {
					throw new BadRequestError(
						`Checkpoint hash mismatch: expected ${expectedHash}, got ${actualHash}`,
					);
				}
			}

			const merged = JSON.parse(newJson);
			await this.upsertCheckpoint(updateId, merged);
		});
	}

	async appendJournalEntries(updateId: string, batch: JournalEntries): Promise<void> {
		return withDbSpan("appendJournalEntries", { "update.id": updateId }, async () => {
			const entries = batch.entries ?? [];
			if (entries.length === 0) {
				return;
			}
			if (entries.length > MAX_JOURNAL_ENTRIES) {
				throw new BadRequestError(`Too many journal entries (max ${MAX_JOURNAL_ENTRIES})`);
			}

			const hasNonElided = entries.some((entry: JournalEntry) => !entry.elideWrite);
			await this.db.transaction(async (tx) => {
				const lockedUpdate = await this.lockUpdateForWrite(tx, updateId);
				const rows = entries.map((entry: JournalEntry) =>
					journalEntryValues(updateId, lockedUpdate.stackId, entry),
				);

				await tx.insert(journalEntries).values(rows).onConflictDoNothing();
				if (hasNonElided) {
					await this.flushJournalToCheckpoint(tx, updateId, lockedUpdate.stackId);
				}
			});
			journalEntriesCount().add(entries.length, { "update.id": updateId });
		});
	}

	async postEvents(updateId: string, batch: EngineEventBatch): Promise<void> {
		const events = (batch as { events?: EngineEvent[] }).events;
		if (!events || events.length === 0) {
			return;
		}
		if (events.length > MAX_EVENT_BATCH_SIZE) {
			throw new BadRequestError(`Too many events (max ${MAX_EVENT_BATCH_SIZE})`);
		}

		return withDbSpan(
			"postEvents",
			{ "update.id": updateId, "events.count": events.length },
			async () => {
				const rows = events.map((event) => ({
					updateId,
					sequence: (event as { sequence?: number }).sequence ?? 0,
					kind: detectEventKind(event),
					fields: event as unknown,
				}));

				// Events are append-only with onConflictDoUpdate; we deliberately do NOT
				// take an update-row lock here — under high concurrency (Pulumi CLI fans
				// out 20+ parallel event batches per `pulumi up`) a SELECT FOR UPDATE on
				// the shared row serializes every writer and degrades into 5xx. The
				// status/lease-after-cancel guard is enforced on the checkpoint write
				// path (where stale state is dangerous); for engine events any late
				// arrival is harmless and the unique (updateId, sequence) index handles
				// duplicates.
				await this.db
					.insert(updateEvents)
					.values(rows)
					.onConflictDoUpdate({
						target: [updateEvents.updateId, updateEvents.sequence],
						set: { kind: sql`excluded.kind`, fields: sql`excluded.fields` },
					});

				this.db.execute(sql`SELECT pg_notify('update_events', ${updateId})`).catch(() => {});
			},
		);
	}

	async getUpdateEvents(
		updateId: string,
		continuationToken?: string,
	): Promise<GetUpdateEventsResponse> {
		return withDbSpan("getUpdateEvents", { "update.id": updateId }, async () => {
			const lastSeq = continuationToken ? Number.parseInt(continuationToken, 10) : 0;

			const rows = await this.db
				.select()
				.from(updateEvents)
				.where(and(eq(updateEvents.updateId, updateId), gt(updateEvents.sequence, lastSeq)))
				.orderBy(updateEvents.sequence);

			const eventsList = rows.map((row) => row.fields as EngineEvent);

			// Check if update is still running
			const [update] = await this.db
				.select({ status: updates.status })
				.from(updates)
				.where(eq(updates.id, updateId));

			const isTerminal =
				update?.status === "succeeded" ||
				update?.status === "failed" ||
				update?.status === "cancelled";

			let nextToken: string | undefined;
			if (rows.length > 0 && !isTerminal) {
				nextToken = String(rows[rows.length - 1].sequence);
			}

			return {
				events: eventsList,
				continuationToken: nextToken,
			} as unknown as GetUpdateEventsResponse;
		});
	}

	async renewLease(
		updateId: string,
		request: RenewUpdateLeaseRequest,
	): Promise<RenewUpdateLeaseResponse> {
		return withDbSpan("renewLease", { "update.id": updateId }, async () => {
			const [row] = await this.db.select().from(updates).where(eq(updates.id, updateId));

			if (!row) {
				throw new UpdateNotFoundError(updateId);
			}

			if (!row.leaseToken) {
				throw new LeaseExpiredError();
			}

			if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() < Date.now()) {
				throw new LeaseExpiredError();
			}

			const duration = Math.min(
				(request as { duration?: number }).duration ?? LEASE_DURATION_SECONDS,
				LEASE_DURATION_SECONDS,
			);
			const newExpiry = leaseExpiresAt(duration);

			await this.db
				.update(updates)
				.set({ leaseExpiresAt: newExpiry, updatedAt: sql`now()` })
				.where(eq(updates.id, updateId));

			return {
				token: row.leaseToken,
				tokenExpiration: Math.floor(newExpiry.getTime() / 1000),
			} as RenewUpdateLeaseResponse;
		});
	}

	// ========================================================================
	// T8.4 — State Operations + Crypto Methods
	// ========================================================================

	async exportStack(stackId: string, version?: number): Promise<UntypedDeployment> {
		return withDbSpan("exportStack", { "stack.id": stackId }, async () => {
			let checkpoint: typeof checkpoints.$inferSelect | undefined;

			if (version !== undefined) {
				const rows = await this.db
					.select()
					.from(checkpoints)
					.where(and(eq(checkpoints.stackId, stackId), eq(checkpoints.version, version)))
					.orderBy(desc(checkpoints.version))
					.limit(1);
				checkpoint = rows[0];
				if (!checkpoint) {
					throw new CheckpointNotFoundError("", "", `version ${version}`);
				}
			} else {
				const rows = await this.db
					.select()
					.from(checkpoints)
					.where(and(eq(checkpoints.stackId, stackId), eq(checkpoints.isDelta, false)))
					.orderBy(desc(checkpoints.createdAt))
					.limit(1);
				checkpoint = rows[0];
				if (!checkpoint) {
					return emptyDeployment();
				}
			}

			let deploymentData: unknown;
			if (checkpoint.blobKey) {
				const data = await this.storage.get(checkpoint.blobKey);
				if (!data) {
					throw new Error("Checkpoint blob data missing from storage");
				}
				deploymentData = JSON.parse(new TextDecoder().decode(data));
			} else {
				deploymentData = checkpoint.data;
			}

			return {
				version: 3,
				deployment: deploymentData,
			} as UntypedDeployment;
		});
	}

	async importStack(stackId: string, deployment: UntypedDeployment): Promise<ImportStackResponse> {
		return withDbSpan("importStack", { "stack.id": stackId }, async () => {
			const updateRow = await this.db.transaction(async (tx) => {
				const stackLock = await this.lockStackForImport(tx, stackId);
				if (stackLock.activeUpdateId) {
					throw new ImportConflictError();
				}

				const [row] = await tx
					.insert(updates)
					.values({
						stackId,
						kind: "import",
						status: "succeeded",
						completedAt: sql`now()`,
					})
					.returning();

				await this.upsertCheckpointInTransaction(tx, row.id, deployment.deployment, {
					requireRunningLease: false,
				});

				return row;
			});

			return { updateId: updateRow.id } satisfies ImportStackResponse;
		});
	}

	async encryptValue(stack: StackCryptoInput, plaintext: Uint8Array): Promise<Uint8Array> {
		return this.crypto.encrypt(stack, plaintext);
	}

	async decryptValue(stack: StackCryptoInput, ciphertext: Uint8Array): Promise<Uint8Array> {
		return this.crypto.decrypt(stack, ciphertext);
	}

	async batchEncrypt(stack: StackCryptoInput, plaintexts: Uint8Array[]): Promise<Uint8Array[]> {
		return Promise.all(plaintexts.map((p) => this.crypto.encrypt(stack, p)));
	}

	async batchDecrypt(stack: StackCryptoInput, ciphertexts: Uint8Array[]): Promise<Uint8Array[]> {
		return Promise.all(ciphertexts.map((c) => this.crypto.decrypt(stack, c)));
	}

	// ========================================================================
	// Private Helpers
	// ========================================================================

	private async nextCheckpointVersion(tx: DbTransaction, updateId: string): Promise<number> {
		const [row] = this.readExecuteRows<NextCheckpointVersionRow>(
			await tx.execute(sql`
				SELECT COALESCE(MAX(version), 0) + 1 AS "nextVersion"
				FROM checkpoints
				WHERE update_id = ${updateId}
			`),
		);

		const nextVersion = row?.nextVersion ?? 1;
		return Number(nextVersion);
	}

	private clearUpdateCaches(updateId: string): void {
		this.baseDeploymentCache.delete(updateId);
	}

	private evictStaleCaches(): void {
		if (this.baseDeploymentCache.size > 64) {
			this.baseDeploymentCache.clear();
		}
	}

	private async flushJournalToCheckpoint(
		tx: DbTransaction,
		updateId: string,
		stackId: string,
	): Promise<void> {
		return withDbSpan("flushJournalToCheckpoint", { "update.id": updateId }, async () => {
			this.evictStaleCaches();

			const allEntries = await tx
				.select()
				.from(journalEntries)
				.where(eq(journalEntries.updateId, updateId))
				.orderBy(journalEntries.sequenceId);

			if (allEntries.length === 0) return;

			let baseDeployment = this.baseDeploymentCache.get(updateId);
			if (!baseDeployment) {
				baseDeployment = await this.loadBaseDeploymentForUpdate(tx, stackId, updateId);
				this.baseDeploymentCache.set(updateId, baseDeployment);
			}

			const reconstructed = applyJournalEntries(baseDeployment, allEntries);
			await this.upsertCheckpointInTransaction(tx, updateId, reconstructed);
		});
	}

	private async upsertCheckpoint(
		updateId: string,
		data: unknown,
		options?: { requireRunningLease?: boolean },
	): Promise<void> {
		return withDbSpan("upsertCheckpoint", { "update.id": updateId }, () =>
			this.db.transaction((tx) => this.upsertCheckpointInTransaction(tx, updateId, data, options)),
		);
	}

	private async upsertCheckpointInTransaction(
		tx: DbTransaction,
		updateId: string,
		data: unknown,
		options?: { requireRunningLease?: boolean },
	): Promise<void> {
		const serialized = JSON.stringify(data);
		const lockedUpdate = await this.lockUpdateForWrite(tx, updateId, options);

		checkpointSizeHistogram().record(Buffer.byteLength(serialized, "utf8"), {
			"stack.id": lockedUpdate.stackId,
		});
		const version = await this.nextCheckpointVersion(tx, updateId);

		let blobKey: string | null = null;
		const checkpointData: unknown = data;
		if (serialized.length > BLOB_THRESHOLD) {
			blobKey = formatBlobKey(lockedUpdate.stackId, updateId, version);
			await this.storage.put(blobKey, new TextEncoder().encode(serialized));
			await tx
				.insert(checkpoints)
				.values({
					updateId,
					stackId: lockedUpdate.stackId,
					version,
					data: null,
					blobKey,
					isDelta: false,
					createdAt: sql`clock_timestamp()`,
				})
				.onConflictDoUpdate({
					target: [checkpoints.updateId, checkpoints.version],
					set: { data: null, blobKey, isDelta: false, createdAt: sql`clock_timestamp()` },
				});
			return;
		}

		await tx
			.insert(checkpoints)
			.values({
				updateId,
				stackId: lockedUpdate.stackId,
				version,
				data: checkpointData,
				blobKey,
				isDelta: false,
				createdAt: sql`clock_timestamp()`,
			})
			.onConflictDoUpdate({
				target: [checkpoints.updateId, checkpoints.version],
				set: {
					data: checkpointData,
					blobKey,
					isDelta: false,
					createdAt: sql`clock_timestamp()`,
				},
			});
	}

	private async lockUpdateForWrite(
		tx: DbTransaction,
		updateId: string,
		options?: { requireRunningLease?: boolean },
	): Promise<LockedUpdateRow> {
		const [row] = this.readExecuteRows<LockedUpdateRow>(
			await tx.execute(sql`
				SELECT stack_id AS "stackId", status, lease_token AS "leaseToken", lease_expires_at AS "leaseExpiresAt"
				FROM updates
				WHERE id = ${updateId}
				FOR UPDATE
			`),
		);

		if (!row) {
			throw new UpdateNotFoundError(updateId);
		}

		if (options?.requireRunningLease === false) {
			return row;
		}

		if (
			row.status !== "running" ||
			!row.leaseToken ||
			(row.leaseExpiresAt != null && row.leaseExpiresAt.getTime() < Date.now())
		) {
			throw new LeaseExpiredError();
		}

		return row;
	}

	private async lockStackForImport(tx: DbTransaction, stackId: string): Promise<StackLockRow> {
		const [row] = this.readExecuteRows<StackLockRow>(
			await tx.execute(sql`
				SELECT active_update_id AS "activeUpdateId"
				FROM stacks
				WHERE id = ${stackId}
				FOR UPDATE
			`),
		);

		if (!row) {
			throw new Error(`Stack not found: ${stackId}`);
		}

		return row;
	}

	private readExecuteRows<T>(result: unknown): T[] {
		if (Array.isArray(result)) {
			return result as T[];
		}

		if (typeof result === "object" && result !== null && "rows" in result) {
			const rows = (result as { rows?: unknown }).rows;
			if (Array.isArray(rows)) {
				return rows as T[];
			}
		}

		throw new Error("Unexpected database execute result shape");
	}

	private async loadBaseDeploymentForUpdate(
		tx: DbTransaction,
		stackId: string,
		updateId: string,
	): Promise<Record<string, unknown>> {
		const [row] = await tx
			.select()
			.from(checkpoints)
			.where(
				and(
					eq(checkpoints.stackId, stackId),
					ne(checkpoints.updateId, updateId),
					eq(checkpoints.isDelta, false),
				),
			)
			.orderBy(desc(checkpoints.createdAt))
			.limit(1);

		if (!row) {
			return {
				manifest: { time: new Date().toISOString(), magic: "", version: "" },
				secrets_providers: { type: "passphrase", state: {} },
				resources: [],
				pending_operations: [],
			};
		}

		if (row.blobKey) {
			const raw = await this.storage.get(row.blobKey);
			if (!raw) {
				throw new Error("Checkpoint blob data missing from storage");
			}
			return JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
		}

		return (row.data as Record<string, unknown>) ?? {};
	}
}

// ============================================================================
// Pure Helpers (exported for testing)
// ============================================================================

/** Map DB status string to Pulumi API status string. */
export function mapStatusToApiStatus(dbStatus: string): string {
	switch (dbStatus) {
		case "not started":
			return "not-started";
		case "requested":
			return "not-started";
		case "running":
			return "in-progress";
		case "succeeded":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		default:
			return dbStatus;
	}
}

export function journalEntryValues(updateId: string, stackId: string, entry: JournalEntry) {
	if (
		typeof entry.sequenceID !== "number" ||
		typeof entry.operationID !== "number" ||
		typeof entry.kind !== "number"
	) {
		throw new BadRequestError(
			"Invalid journal entry: sequenceID, operationID, and kind must be numbers",
		);
	}

	return {
		updateId,
		stackId,
		sequenceId: BigInt(entry.sequenceID),
		operationId: BigInt(entry.operationID),
		kind: entry.kind,
		state: entry.state ?? null,
		operation: entry.operation ?? null,
		secretsProvider: entry.secretsProvider ?? null,
		newSnapshot: entry.newSnapshot ?? null,
		operationType: null,
		removeOld: entry.removeOld != null ? BigInt(entry.removeOld) : null,
		removeNew: entry.removeNew != null ? BigInt(entry.removeNew) : null,
		pendingReplacementOld:
			entry.pendingReplacementOld != null ? BigInt(entry.pendingReplacementOld) : null,
		pendingReplacementNew:
			entry.pendingReplacementNew != null ? BigInt(entry.pendingReplacementNew) : null,
		deleteOld: entry.deleteOld != null ? BigInt(entry.deleteOld) : null,
		deleteNew: entry.deleteNew != null ? BigInt(entry.deleteNew) : null,
		isRefresh: entry.isRefresh ?? false,
		elideWrite: entry.elideWrite ?? false,
	};
}

export interface JournalRow {
	kind: number;
	operationId: number | bigint;
	state: unknown;
	operation: unknown;
	secretsProvider: unknown;
	newSnapshot: unknown;
	operationType: string | null;
	removeOld: bigint | null;
	removeNew: bigint | null;
	pendingReplacementOld: bigint | null;
	pendingReplacementNew: bigint | null;
	deleteOld: bigint | null;
	deleteNew: bigint | null;
	isRefresh: boolean;
	elideWrite: boolean;
}

export function applyJournalEntries(
	baseDeployment: Record<string, unknown>,
	entries: JournalRow[],
): Record<string, unknown> {
	let deployment = { ...baseDeployment };

	const newResources: Array<ResourceV3 | null> = [];
	const opIdToNewIdx = new Map<string, number>();
	const incompleteOps = new Map<string, OperationV2>();
	const toDeleteInSnapshot = new Set<number>();
	const toReplaceInSnapshot = new Map<number, ResourceV3>();
	const markAsDeletion = new Set<number>();
	const markAsPendingReplacement = new Set<number>();
	let hasRefresh = false;

	const updateNewResource = (
		operationId: bigint,
		update: (resource: ResourceV3) => ResourceV3 | null,
	): void => {
		const index = opIdToNewIdx.get(String(operationId));
		if (index !== undefined) {
			const resource = newResources[index];
			if (resource) newResources[index] = update(resource);
		}
	};

	for (const entry of entries) {
		const opKey = String(entry.operationId);
		const state = entry.state as ResourceV3 | null | undefined;

		switch (entry.kind) {
			case JournalEntryWrite: {
				const snapshot = entry.newSnapshot as Record<string, unknown> | null;
				if (snapshot) deployment = { ...snapshot };
				break;
			}

			case JournalEntrySecretsManager: {
				const secretsProvider = entry.secretsProvider as { type: string; state: unknown } | null;
				if (secretsProvider) deployment.secrets_providers = secretsProvider;
				break;
			}

			case JournalEntryBegin: {
				if (entry.operation) incompleteOps.set(opKey, entry.operation as OperationV2);
				break;
			}

			case JournalEntrySuccess: {
				incompleteOps.delete(opKey);
				if (state) {
					const index = newResources.length;
					newResources.push(state);
					opIdToNewIdx.set(opKey, index);
				}
				if (entry.removeOld != null) toDeleteInSnapshot.add(Number(entry.removeOld));
				if (entry.removeNew != null) updateNewResource(entry.removeNew, () => null);
				if (entry.deleteOld != null) markAsDeletion.add(Number(entry.deleteOld));
				if (entry.deleteNew != null) {
					updateNewResource(entry.deleteNew, (resource) => ({ ...resource, delete: true }));
				}
				if (entry.pendingReplacementOld != null) {
					markAsPendingReplacement.add(Number(entry.pendingReplacementOld));
				}
				if (entry.pendingReplacementNew != null) {
					updateNewResource(entry.pendingReplacementNew, (resource) => ({
						...resource,
						pendingReplacement: true,
					}));
				}
				if (entry.isRefresh) hasRefresh = true;
				break;
			}

			case JournalEntryFailure: {
				incompleteOps.delete(opKey);
				break;
			}

			case JournalEntryRefreshSuccess: {
				incompleteOps.delete(opKey);
				hasRefresh = true;
				if (entry.removeOld != null) {
					if (state) {
						toReplaceInSnapshot.set(Number(entry.removeOld), state);
					} else {
						toDeleteInSnapshot.add(Number(entry.removeOld));
					}
				}
				if (entry.removeNew != null) {
					updateNewResource(entry.removeNew, () => state ?? null);
				}
				break;
			}

			case JournalEntryOutputs: {
				if (state && entry.removeOld != null) {
					toReplaceInSnapshot.set(Number(entry.removeOld), state);
				} else if (state && entry.removeNew != null) {
					updateNewResource(entry.removeNew, () => state);
				}
				break;
			}

			case JournalEntryRebuiltBaseState: {
				deployment = rebuildFromJournal(deployment, {
					newResources,
					incompleteOps,
					toDeleteInSnapshot,
					toReplaceInSnapshot,
					markAsDeletion,
					markAsPendingReplacement,
					hasRefresh,
				});
				newResources.length = 0;
				opIdToNewIdx.clear();
				incompleteOps.clear();
				toDeleteInSnapshot.clear();
				toReplaceInSnapshot.clear();
				markAsDeletion.clear();
				markAsPendingReplacement.clear();
				break;
			}

			default:
				break;
		}
	}

	return rebuildFromJournal(deployment, {
		newResources,
		incompleteOps,
		toDeleteInSnapshot,
		toReplaceInSnapshot,
		markAsDeletion,
		markAsPendingReplacement,
		hasRefresh,
	});
}

interface JournalReplayState {
	newResources: Array<ResourceV3 | null>;
	incompleteOps: Map<string, OperationV2>;
	toDeleteInSnapshot: Set<number>;
	toReplaceInSnapshot: Map<number, ResourceV3>;
	markAsDeletion: Set<number>;
	markAsPendingReplacement: Set<number>;
	hasRefresh: boolean;
}

function rebuildFromJournal(
	base: Record<string, unknown>,
	state: JournalReplayState,
): Record<string, unknown> {
	const baseResources = ((base.resources ?? []) as ResourceV3[]).map((resource) => ({
		...resource,
	}));

	for (const [index, replacement] of state.toReplaceInSnapshot) {
		if (index >= 0 && index < baseResources.length) baseResources[index] = replacement;
	}

	// Match Pulumi's JournalReplayer: successful resources form the current plan's
	// topological order and must precede surviving resources from the base snapshot.
	// Keeping replacements at their old base index can put a resource before a newly
	// created dependency and produces a snapshot the CLI refuses to deserialize.
	const resources = state.newResources.filter(
		(resource): resource is ResourceV3 => resource != null,
	);
	for (const [index, baseResource] of baseResources.entries()) {
		if (state.toDeleteInSnapshot.has(index)) continue;
		let resource = baseResource;
		if (state.markAsPendingReplacement.has(index)) {
			resource = { ...resource, pendingReplacement: true };
		}
		if (state.markAsDeletion.has(index)) resource = { ...resource, delete: true };
		resources.push(resource);
	}

	if (state.hasRefresh) rebuildDependencies(resources);

	const pendingOperations = [...state.incompleteOps.values()];
	for (const operation of (base.pending_operations ?? []) as OperationV2[]) {
		if (operation.type === "creating") pendingOperations.push(operation);
	}

	return {
		...base,
		resources,
		pending_operations: pendingOperations,
	};
}

function rebuildDependencies(resources: ResourceV3[]): void {
	const referenceable = new Set<string>();

	for (const resource of resources) {
		if (resource.dependencies) {
			resource.dependencies = resource.dependencies.filter((dependency) =>
				referenceable.has(dependency),
			);
		}
		if (resource.property_dependencies) {
			resource.property_dependencies = Object.fromEntries(
				Object.entries(resource.property_dependencies)
					.map(
						([property, dependencies]) =>
							[
								property,
								dependencies.filter((dependency) => referenceable.has(dependency)),
							] as const,
					)
					.filter(([, dependencies]) => dependencies.length > 0),
			);
		}
		if (resource.replaceWith) {
			resource.replaceWith = resource.replaceWith.filter((urn) => referenceable.has(urn));
		}
		if (resource.deletedWith && !referenceable.has(resource.deletedWith)) {
			delete resource.deletedWith;
		}
		referenceable.add(resource.urn);
	}

	const availableParents = new Map<string, string | undefined>();
	for (const resource of resources) {
		if (resource.parent && !referenceable.has(resource.parent)) {
			resource.parent = availableParents.get(resource.parent);
		}
		availableParents.set(resource.urn, resource.parent);
	}
}

/** Detect the event kind from an EngineEvent by checking which field is non-null. */
export function detectEventKind(event: EngineEvent): string {
	const e = event as unknown as Record<string, unknown>;
	if (e.cancelEvent) return "cancel";
	if (e.stdoutEvent) return "stdout";
	if (e.diagnosticEvent) return "diagnostic";
	if (e.preludeEvent) return "prelude";
	if (e.summaryEvent) return "summary";
	if (e.resourcePreEvent) return "resource-pre";
	if (e.resOutputsEvent) return "res-outputs";
	if (e.resOpFailedEvent) return "res-op-failed";
	if (e.policyEvent) return "policy";
	if (e.errorEvent) return "error";
	if (e.progressEvent) return "progress";
	return "unknown";
}
