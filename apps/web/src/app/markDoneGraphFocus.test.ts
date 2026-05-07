import { describe, expect, it, vi } from "vitest";
import type { AgentRun, Task } from "@aware/shared";
import {
	activeGraphFocusNodeId,
	focusedGraphNodeIds,
	graphNodeFocusPath,
	markDoneGraphTarget,
	projectGraphFocusPath,
	runAfterMarkDoneSuccess,
	shouldSkipGraphViewportSync,
} from "./markDoneGraphFocus";

describe("mark-done graph focus helpers", () => {
	it("builds exact graph node URLs that preserve encoded project and node ids", () => {
		expect(graphNodeFocusPath("project/one", "run:run one&two")).toBe(
			"/projects/project%2Fone?focus=run%3Arun+one%26two",
		);
		expect(projectGraphFocusPath("project/one", "task one&two")).toBe(
			"/projects/project%2Fone?focusTaskId=task+one%26two",
		);
	});

	it("derives exact completed run focus before mutable task payloads", () => {
		const run = { id: "run-payload", taskId: "run-task" } as AgentRun;
		const task = { id: "task-payload", projectId: "payload-project" } as Task;
		expect(
			markDoneGraphTarget({
				projectId: "route-project",
				taskId: "route-task",
				runId: "route-run",
				run,
				task,
			}),
		).toBe("/projects/route-project?focus=run%3Aroute-run");
	});

	it("focuses completed gate/checkpoint when no completed run id is present", () => {
		expect(
			markDoneGraphTarget({
				projectId: "project",
				taskId: "task",
			}),
		).toBe("/projects/project?focus=checkpoint%3Atask");
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
			"navigate:/projects/project?focus=checkpoint%3Atask",
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

	it("treats an exact focus node as one-shot after it has been consumed", () => {
		expect(activeGraphFocusNodeId("run:one", "")).toBe("run:one");
		expect(activeGraphFocusNodeId("run:one", "run:one")).toBe("");
		expect(activeGraphFocusNodeId("run:two", "run:one")).toBe("run:two");
		expect(shouldSkipGraphViewportSync("run:one", "", "")).toBe(true);
		expect(shouldSkipGraphViewportSync("run:one", "", "task:one")).toBe(false);
	});

	it("focuses exact completed node first and falls back to task-level legacy focus", () => {
		const nodes = [
			{ id: "task:t1", data: { taskId: "t1" } },
			{ id: "run:task-lane", data: { taskId: "t1", lane: "task" } },
			{ id: "run:gate-lane", data: { taskId: "t1", lane: "gate" } },
			{ id: "checkpoint:t1", data: { taskId: "t1" } },
			{ id: "run:deleted", data: { taskId: "t2", lane: "task" } },
		];
		expect(
			focusedGraphNodeIds(nodes, { nodeId: "checkpoint:t1", taskId: "t1" }),
		).toEqual([{ id: "checkpoint:t1" }]);
		expect(
			focusedGraphNodeIds(nodes, { nodeId: "checkpoint:missing", taskId: "" }),
		).toEqual([]);
		expect(focusedGraphNodeIds(nodes, "t1")).toEqual([
			{ id: "task:t1" },
			{ id: "run:task-lane" },
			{ id: "run:gate-lane" },
			{ id: "checkpoint:t1" },
		]);
	});
});
