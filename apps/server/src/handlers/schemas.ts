import { SUPPORTED_DEPLOYMENT_SCHEMA_VERSION } from "@procella/updates";
import { z } from "zod";

export const MAX_JSON_DEPTH = 32;
export const MAX_STRING_LENGTH = 1024 * 1024;
export const MAX_EVENT_BATCH_SIZE = 1000;
export const MAX_BATCH_CRYPT_ITEMS = 1000;
export const MAX_FEATURE_COUNT = 100;
export const MAX_LEASE_DURATION_SECONDS = 300;

const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const BoundedString = (max: number) => z.string().max(max);
export const BoundedJSON = z.unknown();

function addBoundedJsonIssues(
	value: unknown,
	ctx: z.RefinementCtx,
	depth = 1,
	path: (string | number)[] = [],
): void {
	if (depth > MAX_JSON_DEPTH) {
		ctx.addIssue({
			code: "custom",
			path,
			message: `JSON body exceeds maximum depth of ${MAX_JSON_DEPTH}`,
		});
		return;
	}

	if (typeof value === "string") {
		if (value.length > MAX_STRING_LENGTH) {
			ctx.addIssue({
				code: "too_big",
				origin: "string",
				path,
				maximum: MAX_STRING_LENGTH,
				inclusive: true,
				type: "string",
				message: `String field exceeds maximum length of ${MAX_STRING_LENGTH}`,
			});
		}
		return;
	}

	if (value === null || typeof value !== "object") {
		return;
	}

	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			addBoundedJsonIssues(item, ctx, depth + 1, [...path, index]);
		}
		return;
	}

	for (const [key, nestedValue] of Object.entries(value)) {
		if (FORBIDDEN_JSON_KEYS.has(key)) {
			ctx.addIssue({
				code: "custom",
				path: [...path, key],
				message: `Forbidden JSON key: ${key}`,
			});
		}
		addBoundedJsonIssues(nestedValue, ctx, depth + 1, [...path, key]);
	}
}

function withJsonBounds<T extends z.ZodTypeAny>(schema: T): T {
	return schema.superRefine((value, ctx) => {
		addBoundedJsonIssues(value, ctx);
	}) as T;
}

/**
 * Procella advertises `deployment-schema-version` 3, so a compliant CLI downgrades to v3 and
 * drops `features` before sending. Anything else would be accepted here and then silently
 * re-exported as v3 with the feature data lost, so it is rejected at the wire boundary.
 */
const DeploymentSchemaVersion = z
	.number()
	.int()
	.nonnegative()
	.max(
		SUPPORTED_DEPLOYMENT_SCHEMA_VERSION,
		`Unsupported deployment schema version: Procella supports up to version ${SUPPORTED_DEPLOYMENT_SCHEMA_VERSION}`,
	);

const FeatureListSchema = z
	.array(BoundedString(MAX_STRING_LENGTH))
	.max(MAX_FEATURE_COUNT)
	.max(
		0,
		`Unsupported deployment features: Procella supports up to deployment schema version ${SUPPORTED_DEPLOYMENT_SCHEMA_VERSION}`,
	);

const JournalEntrySchema = z
	.object({
		version: z.number().int().nonnegative(),
		kind: z.number().int().nonnegative(),
		operationID: z.number().int().nonnegative(),
		sequenceID: z.number().int().nonnegative(),
		removeOld: z.number().int().nullable().optional(),
		removeNew: z.number().int().nullable().optional(),
		state: BoundedJSON.optional(),
		operation: BoundedJSON.optional(),
		secretsProvider: BoundedJSON.optional(),
		pendingReplacementOld: z.number().int().nullable().optional(),
		pendingReplacementNew: z.number().int().nullable().optional(),
		deleteOld: z.number().int().nullable().optional(),
		deleteNew: z.number().int().nullable().optional(),
		isRefresh: z.boolean().optional(),
		newSnapshot: BoundedJSON.optional(),
		elideWrite: z.boolean().optional(),
	})
	.strict();

export const EngineEventBatchSchema = withJsonBounds(
	z
		.object({
			events: z.array(BoundedJSON).max(MAX_EVENT_BATCH_SIZE),
		})
		.strict(),
);

export const PatchUpdateCheckpointRequestSchema = withJsonBounds(
	z
		.object({
			isInvalid: z.boolean().default(false),
			version: DeploymentSchemaVersion,
			deployment: BoundedJSON,
			features: FeatureListSchema.optional(),
		})
		.strict(),
);

export const PatchUpdateVerbatimCheckpointRequestSchema = withJsonBounds(
	z
		.object({
			version: DeploymentSchemaVersion,
			untypedDeployment: BoundedJSON,
			sequenceNumber: z.number().int().nonnegative(),
		})
		.strict(),
);

export const PatchUpdateCheckpointDeltaRequestSchema = withJsonBounds(
	z
		.object({
			version: DeploymentSchemaVersion,
			// Required: the delta is only safe to apply if the client states the expected result.
			checkpointHash: z
				.string()
				.regex(/^[0-9a-fA-F]{64}$/, "checkpointHash must be a 64-character SHA-256 hex digest"),
			sequenceNumber: z.number().int().nonnegative(),
			deploymentDelta: z.array(BoundedJSON),
		})
		.strict(),
);

export const JournalEntriesSchema = withJsonBounds(
	z
		.object({
			entries: z.array(JournalEntrySchema).optional(),
		})
		.strict(),
);

export const UntypedDeploymentSchema = withJsonBounds(
	z
		.object({
			version: DeploymentSchemaVersion.min(1).optional(),
			features: FeatureListSchema.optional(),
			deployment: BoundedJSON,
		})
		.strict(),
);

export const RenewUpdateLeaseRequestSchema = withJsonBounds(
	z
		.object({
			token: BoundedString(MAX_STRING_LENGTH),
			duration: z.number().int().positive().max(MAX_LEASE_DURATION_SECONDS).default(300),
		})
		.strict(),
);

export const EncryptValueRequestSchema = withJsonBounds(
	z
		.object({
			plaintext: z.string().max(MAX_STRING_LENGTH),
		})
		.strict(),
);

export const DecryptValueRequestSchema = withJsonBounds(
	z
		.object({
			ciphertext: z.string().max(MAX_STRING_LENGTH + 32),
		})
		.strict(),
);

export const BatchEncryptRequestSchema = withJsonBounds(
	z
		.object({
			plaintexts: z.array(z.string().max(MAX_STRING_LENGTH)).max(MAX_BATCH_CRYPT_ITEMS),
		})
		.strict(),
);

export const BatchDecryptRequestSchema = withJsonBounds(
	z
		.object({
			ciphertexts: z.array(z.string().max(MAX_STRING_LENGTH + 32)).max(MAX_BATCH_CRYPT_ITEMS),
		})
		.strict(),
);
