import { describe, expect, it, vi } from "vitest";
import type { AgentRun, Task } from "@aware/shared";
import {
	focusedGraphNodeIds,
	markDoneGraphTarget,
	projectGraphFocusPath,
	runAfterMarkDoneSuccess,
} from "./markDoneGraphFocus";

describe("mark-done graph focus helpers", () => {
	it("builds a project graph URL that preserves encoded project and task ids", () => {
		expect(projectGraphFocusPath("project/one", "task one&two")).toBe(
			"/projects/project%2Fone?focusTaskId=task+one%26two",
		);
	});

	it("derives focus target from route ids before mutable run/task payloads", () => {
		const run = { taskId: "run-task" } as AgentRun;
		const task = { id: "task-payload", projectId: "payload-project" } as Task;
		expect(
			markDoneGraphTarget({
				projectId: "route-project",
				taskId: "route-task",
				run,
				task,
			}),
		).toBe("/projects/route-project?focusTaskId=route-task");
	});

	it("falls back to task/run ids and returns empty when the node identity is missing", () => {
		expect(
			markDoneGraphTarget({
				projectId: "project",
				run: { taskId: "run-task" } as AgentRun,
			}),
		).toBe("/projects/project?focusTaskId=run-task");
		expect(markDoneGraphTarget({ projectId: "project" })).toBe("");
	});

	it("navigates only after the mark-done mutation succeeds", async () => {
		const events: string[] = [];
		const navigate = vi.fn((href: string) => events.push(`navigate:${href}`));
		await expect(
			runAfterMarkDoneSuccess({
				mutation: async () => events.push("mutation"),
				afterSuccess: async () => events.push("refresh"),
				navigate,
				projectId: "project",
				taskId: "task",
			}),
		).resolves.toBe(true);
		expect(events).toEqual([
			"mutation",
			"refresh",
			"navigate:/projects/project?focusTaskId=task",
		]);
	});

	it("does not navigate when mark-done mutation fails", async () => {
		const navigate = vi.fn();
		await expect(
			runAfterMarkDoneSuccess({
				mutation: async () => {
					throw new Error("boom");
				},
				navigate,
				projectId: "project",
				taskId: "task",
			}),
		).rejects.toThrow("boom");
		expect(navigate).not.toHaveBeenCalled();
	});

	it("focuses all graph nodes for task, gate, and run lanes; missing nodes are harmless", () => {
		const nodes = [
			{ id: "task:t1", data: { taskId: "t1" } },
			{ id: "run:task-lane", data: { taskId: "t1", lane: "task" } },
			{ id: "run:gate-lane", data: { taskId: "t1", lane: "gate" } },
			{ id: "checkpoint:t1", data: { taskId: "t1" } },
			{ id: "run:deleted", data: { taskId: "t2", lane: "task" } },
		];
		expect(focusedGraphNodeIds(nodes, "t1")).toEqual([
			{ id: "task:t1" },
			{ id: "run:task-lane" },
			{ id: "run:gate-lane" },
			{ id: "checkpoint:t1" },
		]);
		expect(focusedGraphNodeIds(nodes, "archived-or-deleted")).toEqual([]);
	});
});
