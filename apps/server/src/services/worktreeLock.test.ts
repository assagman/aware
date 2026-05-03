import { describe, expect, it } from "vitest";
import {
	getLock,
	getQueuedLockKeys,
	withQueuedLock,
	withWorktreeLock,
} from "./worktreeLock";

describe("worktree lock", () => {
	it("locks during operation and releases after", async () => {
		await withWorktreeLock("w1", "r1", async () => {
			expect(getLock("w1")).toBe("r1");
		});
		expect(getLock("w1")).toBe(null);
	});

	it("queues same-key work while allowing different keys", async () => {
		const events: string[] = [];
		await Promise.all([
			withQueuedLock("project:p1", async () => {
				events.push("p1:first:start");
				await new Promise((resolve) => setTimeout(resolve, 5));
				events.push("p1:first:end");
			}),
			withQueuedLock("project:p1", async () => {
				events.push("p1:second:start");
				events.push("p1:second:end");
			}),
			withQueuedLock("project:p2", async () => {
				events.push("p2:start");
				events.push("p2:end");
			}),
		]);
		expect(events.indexOf("p1:first:end")).toBeLessThan(
			events.indexOf("p1:second:start"),
		);
		expect(getQueuedLockKeys()).toEqual([]);
	});
});
