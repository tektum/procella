import { describe, expect, test } from "bun:test";
import { isValidUpdateKind } from "./index.js";

describe("@procella/types", () => {
	describe("enum objects", () => {
		test("isValidUpdateKind only allows the update allowlist", () => {
			expect(isValidUpdateKind("update")).toBeTrue();
			expect(isValidUpdateKind("preview")).toBeTrue();
			expect(isValidUpdateKind("refresh")).toBeTrue();
			expect(isValidUpdateKind("destroy")).toBeTrue();
			// 'import' is a valid update kind because Pulumi ImportStack inserts
			// updates rows with kind='import'. Including it in the allowlist (and
			// the matching DB CHECK constraint) is required for state imports to
			// succeed; see commit b583b06 ("C4 follow-up").
			expect(isValidUpdateKind("import")).toBeTrue();
			expect(isValidUpdateKind("badkind")).toBeFalse();
		});
	});
});
