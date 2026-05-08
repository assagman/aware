import type { AgentRun, Project, Task, Worktree } from "@aware/shared";
import type { RuntimeAgent } from "../agentRuntime/runtimeAgent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	projects: [] as Project[],
	tasks: [] as Task[],
	worktrees: [] as Worktree[],
	runs: [] as AgentRun[],
	updates: [] as Array<{ table: string; id: string; patch: unknown }>,
	startRun: vi.fn(),
	continueRun: vi.fn(),
}));

vi.mock("../../db/client", () => ({
	db: {
		list: vi.fn(async (table: string) => (table === "runs" ? state.runs : [])),
		update: vi.fn(async (table: string, id: string, patch: unknown) => {
			state.updates.push({ table, id, patch });
			return { id, ...(patch as object) };
		}),
	},
}));

vi.mock("../agentRuntime/flueRuntime", () => ({
	flueRuntime: { startRun: state.startRun, continueRun: state.continueRun },
}));

vi.mock("../projectService", () => ({
	listProjects: vi.fn(async () => state.projects),
	assertAllowedWorktree: vi.fn(async (id: string) => state.worktrees.find((worktree) => worktree.id === id)),
}));

vi.mock("../taskService", () => ({
	listTasks: vi.fn(async () => state.tasks),
	updateTask: vi.fn(async (id: string, patch: Partial<Task>) => ({ ...state.tasks.find((task) => task.id === id), ...patch })),
}));

vi.mock("../worktreeAgentService", () => ({
	worktreeAgent: {
		ensureTaskWorktree: vi.fn(async () => state.worktrees[0]),
	},
}));

vi.mock("../shippingAgentService", () => ({
	listMainAgentsForRun: vi.fn(async () => [{ id: "main", name: "Main", provider: "openai", model: "gpt", systemPrompt: "", tools: [] } satisfies RuntimeAgent]),
}));

const { deleteRunCommand, retryRunCommand, sendRunMessageCommand, startExecutionPlanCommand, startRunCommand } = await import("./commands");

const stamp = "2026-01-01T00:00:00.000Z";
const project: Project = { id: "project-1", name: "Project", rootPath: "/workspace/project", createdAt: stamp, updatedAt: stamp };
const worktree: Worktree = { id: "worktree-1", projectId: project.id, path: project.rootPath, branch: "main", createdAt: stamp, updatedAt: stamp };
const task: Task = { id: "task-1", projectId: project.id, worktreeId: worktree.id, title: "Task", body: "Body", status: "draft", createdAt: stamp, updatedAt: stamp };

function run(input: Partial<AgentRun> & Pick<AgentRun, "id">): AgentRun {
	return {
		taskId: task.id,
		projectId: project.id,
		worktreeId: worktree.id,
		status: "running",
		sessionId: `session-${input.id}`,
		startedAt: stamp,
		relation: "parallel",
		lane: "task",
		...input,
	};
}

describe("graph_start_run sequential dependency handling", () => {
	beforeEach(() => {
		state.projects = [project];
		state.tasks = [task];
		state.worktrees = [worktree];
		state.runs = [];
		state.updates = [];
		state.startRun.mockReset();
		state.continueRun.mockReset();
		state.startRun.mockResolvedValue(run({ id: "child" }));
	});

	it("rejects sequential runs without a parentRunId", async () => {
		await expect(startRunCommand({ projectId: project.id, taskId: task.id, relation: "sequential" })).rejects.toMatchObject({ status: 400 });
		expect(state.startRun).not.toHaveBeenCalled();
	});

	it("creates sequential runs with parentRunId alongside parallel roots", async () => {
		state.runs = [run({ id: "parallel-a" }), run({ id: "parent" })];

		await startRunCommand({
			projectId: project.id,
			taskId: task.id,
			message: "Run after parent completes.",
			relation: "sequential",
			parentRunId: "parent",
		});

		const input = state.startRun.mock.calls[0]![0];
		expect(input.relation).toBe("sequential");
		expect(input.parentRunId).toBe("parent");
		expect(input.lane).toBe("task");
		expect(input.message).toBe("Run after parent completes.");
	});

	it("rejects duplicate active sequential children for the same parent", async () => {
		state.runs = [
			run({ id: "parent" }),
			run({ id: "existing-child", relation: "sequential", parentRunId: "parent", status: "done" }),
		];

		await expect(startRunCommand({ projectId: project.id, taskId: task.id, relation: "sequential", parentRunId: "parent" })).rejects.toMatchObject({ status: 409 });
		expect(state.startRun).not.toHaveBeenCalled();
	});

	it("ignores deleted duplicate sequential children so replacements can be created", async () => {
		state.runs = [
			run({ id: "parent" }),
			run({ id: "deleted-child", relation: "sequential", parentRunId: "parent", deletedAt: stamp }),
		];

		await startRunCommand({ projectId: project.id, taskId: task.id, relation: "sequential", parentRunId: "parent" });
		expect(state.startRun).toHaveBeenCalledOnce();
		expect(state.startRun.mock.calls[0]![0]).toMatchObject({ relation: "sequential", parentRunId: "parent" });
	});

	it("rejects steering, retry, and delete for read-only delegated runs", async () => {
		state.runs = [run({ id: "delegated", readOnly: true, origin: "delegate_agent", affectsTaskStatus: false })];

		await expect(sendRunMessageCommand({ projectId: project.id, taskId: task.id, runId: "delegated", message: "steer" })).rejects.toMatchObject({ status: 409 });
		await expect(retryRunCommand({ projectId: project.id, taskId: task.id, runId: "delegated" })).rejects.toMatchObject({ status: 409 });
		await expect(deleteRunCommand({ projectId: project.id, taskId: task.id, runId: "delegated" })).rejects.toMatchObject({ status: 409 });
		expect(state.continueRun).not.toHaveBeenCalled();
		expect(state.startRun).not.toHaveBeenCalled();
		expect(state.updates).toEqual([]);
	});

	it("validates a complete execution plan before mutating graph state", async () => {
		await expect(startExecutionPlanCommand({
			version: 1,
			projectId: project.id,
			taskId: task.id,
			runs: [
				{ planId: "child", title: "Child", lane: "task", relation: "sequential", dependsOn: ["missing"], parentPlanId: "missing", prompt: "Run after missing parent." },
			],
		})).rejects.toMatchObject({ status: 400 });

		expect(state.startRun).not.toHaveBeenCalled();
	});

	it("creates a structurally validated execution plan and maps parentPlanId to parentRunId", async () => {
		state.startRun
			.mockImplementationOnce(async () => {
				const created = run({ id: "created-parent", request: "Build helper" });
				state.runs.push(created);
				return created;
			})
			.mockImplementationOnce(async () => {
				const created = run({ id: "created-child", request: "Use helper", relation: "sequential", parentRunId: "created-parent", status: "queued" });
				state.runs.push(created);
				return created;
			});

		const result = await startExecutionPlanCommand({
			version: 1,
			projectId: project.id,
			taskId: task.id,
			duplicateAvoidance: ["Inspect projection first"],
			runs: [
				{ planId: "helper", title: "Build helper", lane: "task", relation: "parallel", dependsOn: [], parentPlanId: null, prompt: "Build the helper first." },
				{ planId: "consumer", title: "Use helper", lane: "task", relation: "sequential", dependsOn: ["helper"], parentPlanId: "helper", prompt: "Use the helper after it is done." },
			],
		});

		expect(result.created.map((item) => item.planId)).toEqual(["helper", "consumer"]);
		expect(state.startRun).toHaveBeenCalledTimes(2);
		expect(state.startRun.mock.calls[0]![0]).toMatchObject({ relation: "parallel", message: "Build the helper first." });
		expect(state.startRun.mock.calls[1]![0]).toMatchObject({ relation: "sequential", parentRunId: "created-parent", message: "Use the helper after it is done." });
	});
});
