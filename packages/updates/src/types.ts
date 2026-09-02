// @procella/updates — Service interface, types, and constants.

import type { StackCryptoInput } from "@procella/crypto";
import type {
	Caller,
	CompleteUpdateRequest,
	EngineEventBatch,
	GetHistoryResponse,
	GetUpdateEventsResponse,
	ImportStackResponse,
	JournalEntries,
	PatchUpdateCheckpointRequest,
	RenewUpdateLeaseRequest,
	RenewUpdateLeaseResponse,
	StartUpdateRequest,
	StartUpdateResponse,
	UntypedDeployment,
	UpdateProgramResponse,
	UpdateResults,
} from "@procella/types";
import { UpdateConflictError } from "@procella/types";

// ============================================================================
// UpdatesService Interface
// ============================================================================

export interface CompletedUpdate {
	stackId: string;
	environment: Record<string, string>;
}

export interface UpdatesService {
	createUpdate(
		stackId: string,
		kind: string,
		config?: unknown,
		program?: unknown,
		caller?: Caller,
		environment?: Record<string, string>,
	): Promise<UpdateProgramResponse>;

	startUpdate(updateId: string, request: StartUpdateRequest): Promise<StartUpdateResponse>;

	completeUpdate(updateId: string, request: CompleteUpdateRequest): Promise<void>;

	getUpdateContext(updateId: string): Promise<CompletedUpdate>;

	cancelUpdate(updateId: string): Promise<void>;

	patchCheckpoint(updateId: string, request: PatchUpdateCheckpointRequest): Promise<void>;

	/**
	 * Persist a verbatim checkpoint. `request.untypedDeploymentText` must be the exact JSON
	 * text the client sent, because subsequent deltas are textual edits against those bytes.
	 */
	patchCheckpointVerbatim(updateId: string, request: VerbatimCheckpointSave): Promise<void>;

	/** Apply a textual delta against the exact text retained by the last verbatim/delta save. */
	patchCheckpointDelta(updateId: string, request: DeltaCheckpointSave): Promise<void>;

	appendJournalEntries(updateId: string, entries: JournalEntries): Promise<void>;

	postEvents(updateId: string, batch: EngineEventBatch): Promise<void>;

	renewLease(updateId: string, request: RenewUpdateLeaseRequest): Promise<RenewUpdateLeaseResponse>;

	getUpdate(updateId: string): Promise<UpdateResults>;

	getUpdateEvents(updateId: string, continuationToken?: string): Promise<GetUpdateEventsResponse>;

	getHistory(stackId: string): Promise<GetHistoryResponse>;

	exportStack(stackId: string, version?: number): Promise<UntypedDeployment>;

	importStack(stackId: string, deployment: UntypedDeployment): Promise<ImportStackResponse>;

	encryptValue(stack: StackCryptoInput, plaintext: Uint8Array): Promise<Uint8Array>;

	decryptValue(stack: StackCryptoInput, ciphertext: Uint8Array): Promise<Uint8Array>;

	batchEncrypt(stack: StackCryptoInput, plaintexts: Uint8Array[]): Promise<Uint8Array[]>;

	batchDecrypt(stack: StackCryptoInput, ciphertexts: Uint8Array[]): Promise<Uint8Array[]>;

	verifyLeaseToken(updateId: string, token: string): Promise<void>;

	verifyUpdateOwnership(updateId: string, stackId: string): Promise<void>;
}

// ============================================================================
// Constants
// ============================================================================

/** Checkpoint data larger than this is stored in blob storage. */
export const BLOB_THRESHOLD = 1_048_576; // 1 MB

/** Default update lease duration in seconds. */
export const LEASE_DURATION_SECONDS = 300; // 5 minutes

/** GC worker scan interval in milliseconds. */
export const GC_INTERVAL_MS = 60_000; // 60 seconds

/** Grace window before GC cancels expired-lease updates (ms). Gives executors time to renew during transient network blips. */
export const GC_LEASE_GRACE_MS = 30_000; // 30 seconds

/** Updates older than this without activity are considered stale. */
export const GC_STALE_THRESHOLD_MS = 3_600_000; // 1 hour

/** PostgreSQL advisory lock ID for cluster-safe GC. */
export const GC_ADVISORY_LOCK_ID = 93_874_835_275_587n; // 0x5472617461_4743 (historic, do not change)

/**
 * Highest Pulumi deployment schema version Procella can persist and re-export without loss.
 * Kept in lockstep with the `deployment-schema-version` capability Procella advertises.
 */
export const SUPPORTED_DEPLOYMENT_SCHEMA_VERSION = 3;

/**
 * Reserved `checkpoints.version` holding the delta baseline sidecar row for an update.
 *
 * Real checkpoint versions start at 1 (`COALESCE(MAX(version), 0) + 1`), so version 0 is
 * invisible to version allocation and to every `MAX(version)` reader. The row carries
 * `is_delta = true` so canonical readers (export, journal replay) skip it. Rolling the delta
 * capability back therefore needs no migration: the sidecar becomes inert data.
 */
export const DELTA_BASE_CHECKPOINT_VERSION = 0;

// ============================================================================
// Internal Errors
// ============================================================================

export class ImportConflictError extends UpdateConflictError {
	constructor(message: string = "Cannot import while stack has active update") {
		super(message);
		this.name = "ImportConflictError";
	}
}

/** Rejected because a checkpoint sequence number is stale, conflicting, or out of order. */
export class CheckpointSequenceError extends UpdateConflictError {
	constructor(message: string) {
		super(message);
		this.name = "CheckpointSequenceError";
	}
}

// ============================================================================
// Checkpoint Save Inputs
// ============================================================================

/** A point inside a textual deployment diff. `offset` is a UTF-8 byte offset. */
export interface TextEditSpanPoint {
	line: number;
	column: number;
	offset: number;
}

export interface TextEditSpan {
	uri?: string;
	start: TextEditSpanPoint;
	end: TextEditSpanPoint;
}

/** One `gotextdiff.TextEdit` as emitted by the Pulumi CLI's deployment differ. */
export interface TextEdit {
	span: TextEditSpan;
	newText: string;
}

/** Service-boundary input for `PATCH .../checkpointverbatim`. */
export interface VerbatimCheckpointSave {
	/** Deployment schema version declared by the client. */
	version: number;
	/** Idempotency/order key, incremented by the client per PATCH within one update. */
	sequenceNumber: number;
	/**
	 * Exact JSON text of the request's `untypedDeployment` member, byte-for-byte as sent.
	 * Parsing and re-serializing this value would break every subsequent delta.
	 */
	untypedDeploymentText: string;
}

/** Service-boundary input for `PATCH .../checkpointdelta`. */
export interface DeltaCheckpointSave {
	/** Deployment schema version declared by the client. */
	version: number;
	/** Idempotency/order key, incremented by the client per PATCH within one update. */
	sequenceNumber: number;
	/** Required SHA-256 hex digest of the text produced by applying `deploymentDelta`. */
	checkpointHash: string;
	/** Textual edits against the exact last-saved deployment text. */
	deploymentDelta: TextEdit[];
}

// ============================================================================
// Internal Row Types (mirror DB schema for type-safe mapping)
// ============================================================================

export interface UpdateRow {
	id: string;
	stackId: string;
	kind: string;
	status: string;
	result: string | null;
	message: string | null;
	version: number;
	leaseToken: string | null;
	leaseExpiresAt: Date | null;
	startedAt: Date | null;
	completedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
	config: unknown;
	program: unknown;
	environment: Record<string, string>;
}

export interface CheckpointRow {
	id: string;
	updateId: string;
	stackId: string;
	version: number;
	data: unknown;
	blobKey: string | null;
	isDelta: boolean;
	createdAt: Date;
}

export interface UpdateEventRow {
	id: string;
	updateId: string;
	sequence: number;
	kind: string;
	fields: unknown;
	createdAt: Date;
}
