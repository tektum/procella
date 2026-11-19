import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../renovate.json", import.meta.url), "utf8"));
const rules: Array<Record<string, unknown>> = config.packageRules;

describe("renovate automerge policy", () => {
	test("automerge is on via platform automerge with squash", () => {
		expect(config.automerge).toBe(true);
		expect(config.platformAutomerge).toBe(true);
		expect(config.automergeStrategy).toBe("squash");
	});

	test("new releases wait out a cooldown before becoming eligible", () => {
		expect(config.minimumReleaseAge).toBe("3 days");
	});

	test("major updates stay manual", () => {
		const rule = rules.find((r) => (r.matchUpdateTypes as string[] | undefined)?.includes("major"));
		expect(rule?.automerge).toBe(false);
	});

	test("0.x minor updates stay manual", () => {
		const rule = rules.find((r) => r.matchCurrentVersion === "/^0\\./");
		expect(rule?.matchUpdateTypes).toEqual(["minor"]);
		expect(rule?.automerge).toBe(false);
	});

	test("lock file maintenance stays manual (Bun re-resolves everything, cooldown does not apply)", () => {
		expect(config.lockFileMaintenance.automerge).toBe(false);
	});
});
