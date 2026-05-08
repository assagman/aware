import type { AgentRun, Task } from "@aware/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	tasks: [] as Task[],
	runs: [] as AgentRun[],
}));

vi.mock("../db/client", () => ({
	db: {
		list: vi.fn(async (table: string) => {
			if (table === "tasks") return state.tasks;
			if (table === "runs") return state.runs;
			return [];
		}),
	},
}));

const { listTasks, allTaskRunsDone } = await import("./taskService");

const stamp = "2026-01-01T00:00:00.000Z";
const task: Task = {
	id: "task-1",
	projectId: "project-1",
	worktreeId: "worktree-1",
	title: "Task",
	body: "Body",
	status: "draft",
	createdAt: stamp,
	updatedAt: stamp,
};

function run(input: Partial<AgentRun> & Pick<AgentRun, "id" | "status">): AgentRun {
	return {
		taskId: task.id,
		projectId: task.projectId,
		worktreeId: task.worktreeId!,
		sessionId: `session-${input.id}`,
		startedAt: stamp,
		...input,
	};
}

describe("delegated child run task isolation", () => {
	beforeEach(() => {
		state.tasks = [task];
		state.runs = [];
	});

	it("ignores delegated non-task-affecting runs in task status rollups", async () => {
		state.runs = [
			run({ id: "normal", status: "done" }),
			run({ id: "delegated-running", status: "running", origin: "delegate_agent", affectsTaskStatus: false }),
			run({ id: "delegated-failed", status: "failed", origin: "delegate_agent", affectsTaskStatus: false }),
		];

		await expect(listTasks({ projectId: task.projectId })).resolves.toMatchObject([
			{ id: task.id, status: "need_review" },
		]);
		await expect(allTaskRunsDone(task.id)).resolves.toBe(true);
	});

	it("uses default task-affecting behavior for historical runs without flags", async () => {
		state.runs = [run({ id: "historical", status: "running" })];

		await expect(listTasks({ projectId: task.projectId })).resolves.toMatchObject([
			{ id: task.id, status: "running" },
		]);
		await expect(allTaskRunsDone(task.id)).resolves.toBe(false);
	});
});
