// PostgresEscService behavior used by stack-managed environments: opening a specific revision or
// a draft, and encrypting secrets. Requires Postgres (skipped otherwise, like service.test.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, type Database, escProjects } from "@procella/db";
import { NotFoundError } from "@procella/types";
import { eq } from "drizzle-orm";
import type { EvaluatePayload, EvaluateResult, EvaluatorClient } from "./evaluator-client.js";
import { decryptEscSecret } from "./secrets.js";
import { PostgresEscService } from "./service.js";

const DB_URL =
	process.env.PROCELLA_TEST_DATABASE_URL ??
	process.env.PROCELLA_DATABASE_URL ??
	"postgres://procella:procella@localhost:5432/procella";

const hasDb = async (): Promise<boolean> => {
	try {
		const { db, client } = await createDb({ url: DB_URL });
		await db.select().from(escProjects).limit(1);
		await client.close();
		return true;
	} catch {
		return false;
	}
};

/** Records each evaluated payload and echoes the definition back as a value. */
class RecordingEvaluator implements EvaluatorClient {
	readonly payloads: EvaluatePayload[] = [];
	async evaluate(payload: EvaluatePayload): Promise<EvaluateResult> {
		this.payloads.push(payload);
		return { values: { definition: payload.definition }, secrets: [], diagnostics: [] };
	}
}

describe.skipIf(!(await hasDb()))("PostgresEscService — managed environments", () => {
	const tenant = `t-${crypto.randomUUID().slice(0, 8)}`;
	const encryptionKeyHex = "11".repeat(32);
	const evaluator = new RecordingEvaluator();
	let db: Database;
	let close: () => Promise<void>;
	let service: PostgresEscService;

	beforeAll(async () => {
		const connection = await createDb({ url: DB_URL });
		db = connection.db;
		close = () => connection.client.close();
		service = new PostgresEscService({ db, evaluator, encryptionKeyHex });
		await service.createEnvironment(
			tenant,
			{ projectName: "app", name: "dev", yamlBody: "values:\n  v: 1\n" },
			"u",
		);
		await service.updateEnvironment(tenant, "app", "dev", { yamlBody: "values:\n  v: 2\n" }, "u");
	});

	afterAll(async () => {
		await db.delete(escProjects).where(eq(escProjects.tenantId, tenant));
		await close();
	});

	const lastDefinition = () => evaluator.payloads.at(-1)?.definition;

	test("opens the current revision by default and passes the tenant to the evaluator", async () => {
		await service.openSession(tenant, "app", "dev");
		expect(lastDefinition()).toBe("values:\n  v: 2\n");
		expect(evaluator.payloads.at(-1)?.tenantId).toBe(tenant);
	});

	test("opens an older published revision", async () => {
		await service.openSession(tenant, "app", "dev", { revision: 1 });
		expect(lastDefinition()).toBe("values:\n  v: 1\n");
	});

	test("rejects a revision that does not exist", async () => {
		await expect(
			service.openSession(tenant, "app", "dev", { revision: 99 }),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("opens an open draft and refuses discarded or unknown drafts", async () => {
		const draft = await service.createDraft(tenant, "app", "dev", "values:\n  v: 3\n", "", "u");
		await service.openSession(tenant, "app", "dev", { draftId: draft.id });
		expect(lastDefinition()).toBe("values:\n  v: 3\n");

		await service.discardDraft(tenant, "app", "dev", draft.id);
		await expect(
			service.openSession(tenant, "app", "dev", { draftId: draft.id }),
		).rejects.toBeInstanceOf(NotFoundError);
		await expect(
			service.openSession(tenant, "app", "dev", { draftId: "not-a-uuid" }),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("encrypts secrets with the tenant key for existing environments only", async () => {
		const [ciphertext] = await service.encryptSecrets(tenant, "app", "dev", [
			new TextEncoder().encode("s3cret"),
		]);
		expect(decryptEscSecret(encryptionKeyHex, tenant, ciphertext ?? "").toString()).toBe("s3cret");

		await expect(
			service.encryptSecrets(tenant, "app", "missing", [new TextEncoder().encode("x")]),
		).rejects.toBeInstanceOf(NotFoundError);
	});
});
