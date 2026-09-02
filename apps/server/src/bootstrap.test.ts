import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PULUMI_FULLY_SUPPORTED_MIN_VERSION, PULUMI_LEGACY_SMOKE_VERSION } from "@procella/types";
import { logCompatibilityPolicy, requireExplicitEncryptionKey } from "./bootstrap.js";
import { logger } from "./logger.js";

const DEV_KEY = createHash("sha256").update("procella-dev-encryption-key").digest("hex");

describe("@procella/server bootstrap", () => {
	test("rejects missing encryption key", () => {
		expect(() => requireExplicitEncryptionKey(undefined)).toThrow(
			/PROCELLA_ENCRYPTION_KEY is required/,
		);
	});

	test("rejects the well-known dev encryption key", () => {
		expect(() => requireExplicitEncryptionKey(DEV_KEY)).toThrow(/well-known dev value/);
	});

	test("accepts explicit random encryption keys", () => {
		expect(requireExplicitEncryptionKey("a".repeat(64))).toBe("a".repeat(64));
	});

	test("rejects uppercase/mixed-case variants of the dev key (PR #149 review — case-insensitive hex compare)", () => {
		expect(() => requireExplicitEncryptionKey(DEV_KEY.toUpperCase())).toThrow(
			/well-known dev value/,
		);
		const mixed = DEV_KEY.split("")
			.map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch))
			.join("");
		expect(() => requireExplicitEncryptionKey(mixed)).toThrow(/well-known dev value/);
	});
});

describe("logCompatibilityPolicy", () => {
	test("emits one structured startup log with the legacy and fully-supported minimum policy values", () => {
		const originalInfo = logger.info;
		const calls: unknown[][] = [];
		logger.info = (...args: unknown[]) => {
			calls.push(args);
		};
		try {
			logCompatibilityPolicy(false);
		} finally {
			logger.info = originalInfo;
		}

		expect(calls.length).toBe(1);
		const [payload, message] = calls[0] as [Record<string, unknown>, string];
		expect(message).toBe("pulumi-compatibility-policy");
		expect(payload.legacySmokeVersion).toBe(PULUMI_LEGACY_SMOKE_VERSION);
		expect(payload.fullySupportedMinVersion).toBe(PULUMI_FULLY_SUPPORTED_MIN_VERSION);
		expect(payload.deltaCheckpointsEnabled).toBe(false);
	});

	test("includes the delta checkpoints opt-in flag when enabled", () => {
		const originalInfo = logger.info;
		const calls: unknown[][] = [];
		logger.info = (...args: unknown[]) => {
			calls.push(args);
		};
		try {
			logCompatibilityPolicy(true);
		} finally {
			logger.info = originalInfo;
		}

		const [payload] = calls[0] as [Record<string, unknown>, string];
		expect(payload.deltaCheckpointsEnabled).toBe(true);
	});

	test("never throws and does not depend on database/auth bootstrap", () => {
		const originalInfo = logger.info;
		logger.info = () => {};
		try {
			expect(() => logCompatibilityPolicy(false)).not.toThrow();
		} finally {
			logger.info = originalInfo;
		}
	});
});
