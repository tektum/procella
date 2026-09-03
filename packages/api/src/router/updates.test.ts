import { describe, expect, test } from "bun:test";
import type { Database } from "@procella/db";
import type { SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { resolveUpdateId } from "./updates.js";

const dialect = new PgDialect();

describe("resolveUpdateId", () => {
	test("numeric update permalinks exclude previews and prefer the latest matching update", async () => {
		let whereSql = "";
		let whereParams: unknown[] = [];
		let orderSql = "";
		const chain = {
			select: () => chain,
			from: () => chain,
			where: (condition: SQLWrapper) => {
				const query = dialect.sqlToQuery(condition.getSQL());
				whereSql = query.sql;
				whereParams = query.params;
				return chain;
			},
			orderBy: (order: SQLWrapper) => {
				orderSql = dialect.sqlToQuery(order.getSQL()).sql;
				return chain;
			},
			limit: () => Promise.resolve([{ id: "actual-update-id" }]),
		};
		const db = { select: chain.select } as unknown as Database;

		const result = await resolveUpdateId(db, "stack-id", "2");
		expect(result).toBe("actual-update-id");
		expect(whereSql).toContain('"updates"."kind" <>');
		expect(whereParams).toEqual(["stack-id", 2, "preview"]);
		expect(orderSql).toBe('"updates"."created_at" desc');
	});
});
