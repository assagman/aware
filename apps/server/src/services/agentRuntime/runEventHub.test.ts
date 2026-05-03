import type { RunEvent } from "@aware/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: RunEvent[] = [];

vi.mock("../../db/client", () => ({
	db: {
		list: vi.fn(async () => rows),
		insert: vi.fn(async (_table: string, row: RunEvent) => {
			rows.push(row);
			return row;
		}),
	},
}));

const { runEventHub } = await import("./runEventHub");

describe("run event hub", () => {
	beforeEach(() => {
		rows.length = 0;
	});

	it("broadcasts deltas immediately but persists them as batches", async () => {
		const runId = `hub-${crypto.randomUUID()}`;
		await runEventHub.hydrateRun(runId);
		const live: string[] = [];
		const unsubscribe = runEventHub.subscribe(runId, (event) => {
			live.push(event.type);
			return true;
		});

		runEventHub.emit(runId, "text_delta", { text: "hel" });
		runEventHub.emit(runId, "text_delta", { text: "lo" });
		expect(live).toEqual(["text_delta", "text_delta"]);

		await runEventHub.flush(runId);
		unsubscribe();
		const persisted = await runEventHub.persistedEvents(runId);
		expect(persisted.map((event) => event.type)).toEqual([
			"message_delta_batch",
		]);
		expect(persisted[0]?.payload).toEqual({ text: "hello" });
	});

	it("persists boundary events immediately and redacts secrets", async () => {
		const runId = `hub-${crypto.randomUUID()}`;
		process.env.AWARE_TEST_SECRET = "secret-value-123";
		runEventHub.emit(
			runId,
			"error",
			{ message: "leaked secret-value-123" },
			{ immediate: true },
		);
		await runEventHub.flush(runId);
		delete process.env.AWARE_TEST_SECRET;

		const persisted = await runEventHub.persistedEvents(runId);
		expect(persisted[0]?.type).toBe("error");
		expect(JSON.stringify(persisted[0]?.payload)).toContain("[REDACTED]");
	});
});
