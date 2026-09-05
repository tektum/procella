// @procella/updates — Update lifecycle domain (updates, events, checkpoints, GC)

export { GCWorker } from "./gc-worker.js";
export * from "./helpers.js";
export {
	deriveGitHubUpdateTarget,
	detectEventKind,
	mapStatusToApiStatus,
	PostgresUpdatesService,
} from "./postgres.js";
export type { RepairMutation } from "./repair.js";
export { detectDanglingParents, detectOrphans, repairCheckpoint } from "./repair.js";
export * from "./types.js";
