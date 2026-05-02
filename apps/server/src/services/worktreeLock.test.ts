import { describe, expect, it } from "vitest";
import { getLock, withWorktreeLock } from "./worktreeLock";

describe("worktree lock", () => {
	it("locks during operation and releases after", async () => {
		await withWorktreeLock("w1", "r1", async () => {
			expect(getLock("w1")).toBe("r1");
		});
		expect(getLock("w1")).toBe(null);
	});
});
