// @procella/server — Checkpoint patch handlers.

import type { JournalEntries, PatchUpdateCheckpointRequest } from "@procella/types";
import type { DeltaCheckpointSave, UpdatesService } from "@procella/updates";
import { extractRawJsonMember, parseTextEdits } from "@procella/updates";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { updateContext } from "./params.js";
import {
	JournalEntriesSchema,
	PatchUpdateCheckpointDeltaRequestSchema,
	PatchUpdateCheckpointRequestSchema,
	PatchUpdateVerbatimCheckpointRequestSchema,
} from "./schemas.js";

// ============================================================================
// Checkpoint Handlers
// ============================================================================

const INVALID_JSON_RESPONSE = {
	code: "invalid_request",
	message: "Body is not valid JSON",
} as const;

export function checkpointHandlers(updates: UpdatesService) {
	return {
		patchCheckpoint: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json(INVALID_JSON_RESPONSE, 400);
			}
			const parseResult = PatchUpdateCheckpointRequestSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			await updates.patchCheckpoint(
				updateCtx.updateId,
				parseResult.data as PatchUpdateCheckpointRequest,
			);
			return c.body(null, 200);
		},

		/**
		 * The delta protocol diffs and hashes the exact `untypedDeployment` text the CLI cached,
		 * so the value is sliced straight out of the request body. Parsing and re-serializing it
		 * would change key order, number formatting, and string escapes, and every subsequent
		 * delta would then fail its hash check.
		 */
		patchCheckpointVerbatim: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			const body = await c.req.text();
			let raw: unknown;
			try {
				raw = JSON.parse(body);
			} catch {
				return c.json(INVALID_JSON_RESPONSE, 400);
			}
			const parseResult = PatchUpdateVerbatimCheckpointRequestSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			const untypedDeploymentText = extractRawJsonMember(body, "untypedDeployment");
			if (untypedDeploymentText === undefined) {
				return c.json({ code: "invalid_request", message: "untypedDeployment is required" }, 400);
			}
			await updates.patchCheckpointVerbatim(updateCtx.updateId, {
				version: parseResult.data.version,
				sequenceNumber: parseResult.data.sequenceNumber,
				untypedDeploymentText,
			});
			return c.body(null, 200);
		},

		patchCheckpointDelta: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json(INVALID_JSON_RESPONSE, 400);
			}
			const parseResult = PatchUpdateCheckpointDeltaRequestSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			const request: DeltaCheckpointSave = {
				version: parseResult.data.version,
				sequenceNumber: parseResult.data.sequenceNumber,
				checkpointHash: parseResult.data.checkpointHash,
				deploymentDelta: parseTextEdits(parseResult.data.deploymentDelta),
			};
			await updates.patchCheckpointDelta(updateCtx.updateId, request);
			return c.body(null, 200);
		},

		appendJournalEntries: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json(INVALID_JSON_RESPONSE, 400);
			}
			const parseResult = JournalEntriesSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			const body: JournalEntries = {
				entries: parseResult.data.entries as JournalEntries["entries"],
			};
			await updates.appendJournalEntries(updateCtx.updateId, body);
			return c.body(null, 200);
		},
	};
}
