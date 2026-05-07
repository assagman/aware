import type { AgentRun, Project, Task, Worktree } from "@aware/shared";
import type { RuntimeAgent } from "./agentRuntime/runtimeAgent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	projects: [] as Project[],
	tasks: [] as Task[],
	worktrees: [] as Worktree[],
	runs: [] as AgentRun[],
	startRun: vi.fn(),
	mainAgents: [] as RuntimeAgent[],
	graphAgents: [] as RuntimeAgent[],
}));

vi.mock("./agentRuntime/flueRuntime", () => ({
	flueRuntime: { startRun: state.startRun },
}));

vi.mock("../db/client", () => ({
	db: {
		list: vi.fn(async (table: string) => (table === "runs" ? state.runs : [])),
	},
}));

vi.mock("./shippingAgentService", () => ({
	listMainAgentsForRun: vi.fn(async () => state.mainAgents),
}));

vi.mock("./graphAgentService", () => ({
	listGraphAgentsForRun: vi.fn(async () => state.graphAgents),
}));

vi.mock("./projectService", () => ({
	listProjects: vi.fn(async () => state.projects),
	listWorktrees: vi.fn(async () => state.worktrees),
}));

vi.mock("./taskService", () => ({
	listTasks: vi.fn(async () => state.tasks),
}));

const { startGraphAgentRunCommand } = await import("./graphAgentRunner");

const stamp = "2026-01-01T00:00:00.000Z";
const project: Project = {
	id: "project-1",
	name: "Project",
	rootPath: "/workspace/project",
	createdAt: stamp,
	updatedAt: stamp,
};
const worktree: Worktree = {
	id: "worktree-1",
	projectId: project.id,
	path: project.rootPath,
	branch: "main",
	createdAt: stamp,
	updatedAt: stamp,
};
const task: Task = {
	id: "task-1",
	projectId: project.id,
	worktreeId: worktree.id,
	title: "Rework auto create runs",
	body: "Create a planner before graph changes. Some work must happen after tests exist.",
	status: "draft",
	createdAt: stamp,
	updatedAt: stamp,
};

function agent(input: Partial<RuntimeAgent> & Pick<RuntimeAgent, "id" | "name">): RuntimeAgent {
	return {
		provider: "openai-codex",
		model: "gpt-test",
		systemPrompt: "prompt",
		tools: [],
		...input,
	};
}

function graphRun(input: Partial<AgentRun> & Pick<AgentRun, "id">): AgentRun {
	const { id, ...rest } = input;
	return {
		id,
		taskId: task.id,
		projectId: project.id,
		worktreeId: worktree.id,
		status: "running",
		sessionId: `session-${id}`,
		lane: "graph",
		request: `- **Mode:** task_runs`,
		startedAt: stamp,
		...rest,
	};
}

describe("auto create task runs orchestration", () => {
	beforeEach(() => {
		state.projects = [project];
		state.tasks = [task];
		state.worktrees = [worktree];
		state.runs = [];
		state.mainAgents = [
			agent({ id: "main-1", name: "Main", tools: ["read", "write", "edit", "bash", "grep", "glob", "task"] }),
			agent({ id: "shipping", name: "Shipping Agent", roleName: "shipping-agent", tools: ["bash"] }),
			agent({ id: "worktree", name: "Worktree Agent", roleName: "worktree-agent", tools: ["bash"] }),
		];
		state.graphAgents = [agent({ id: "graph-1", name: "Graph Agent", roleName: "graph-agent", allowedToolNames: ["graph_get_projection", "graph_start_execution_plan", "graph_start_run"], skillsEnabled: false })];
		state.startRun.mockReset();
		state.startRun.mockResolvedValue({ id: "run-1" } as AgentRun);
	});

	it("starts Main with only Graph Agent available for Auto Create Runs", async () => {
		await startGraphAgentRunCommand({ projectId: project.id, taskId: task.id, mode: "task_runs" });

		expect(state.startRun).toHaveBeenCalledOnce();
		const input = state.startRun.mock.calls[0]![0];
		expect(input.lane).toBe("graph");
		expect(input.affectsTaskStatus).toBe(false);
		expect(input.agents.map((item: RuntimeAgent) => item.roleName ?? item.name)).toEqual(["Main", "graph-agent"]);
		expect(input.agents[0]).toMatchObject({
			id: "main-1",
			name: "Main",
			tools: ["read", "grep", "glob", "delegate_agent"],
			allowedToolNames: ["read", "grep", "glob", "delegate_agent"],
			skillsEnabled: false,
		});
		expect(input.agents[1]).toMatchObject({
			roleName: "graph-agent",
			skillsEnabled: false,
			tools: ["graph_get_projection", "graph_start_execution_plan"],
			allowedToolNames: ["graph_get_projection", "graph_start_execution_plan"],
		});
		expect(input.agents.some((item: RuntimeAgent) => item.roleName === "shipping-agent" || item.roleName === "worktree-agent")).toBe(false);
	});

	it("asks Main to analyze scope/dependencies and hand one validated plan to Graph Agent", async () => {
		await startGraphAgentRunCommand({ projectId: project.id, taskId: task.id, mode: "task_runs" });

		const message = state.startRun.mock.calls[0]![0].message as string;
		expect(message).toMatch(/Analyze the task as Main/i);
		expect(message).toMatch(/Break down all required implementation work/i);
		expect(message).toMatch(/sequential task-lane runs/i);
		expect(message).toMatch(/avoid duplicate active\/completed/i);
		expect(message).toMatch(/Execution plan contract/i);
		expect(message).toMatch(/delegate_agent/i);
		expect(message).toMatch(/role `graph-agent`/i);
		expect(message).toMatch(/graph_start_execution_plan/i);
		expect(message).toMatch(/machine-validate the complete plan before creating runs/i);
		expect(message).not.toMatch(/Do not call graph_\* tools directly from Main unless delegation is unavailable/i);
	});

	it("preserves missing task body as an explicit none marker", async () => {
		state.tasks = [{ ...task, body: "" }];
		await startGraphAgentRunCommand({ projectId: project.id, taskId: task.id, mode: "task_runs" });

		const input = state.startRun.mock.calls[0]![0];
		expect(input.message).toContain("(none)");
		expect(input.task.body).toContain("(none)");
	});

	it("still uses Graph Agent directly for non-planning graph automation", async () => {
		await startGraphAgentRunCommand({ projectId: project.id, taskId: task.id, mode: "gate_runs" });

		const input = state.startRun.mock.calls[0]![0];
		expect(input.agents).toEqual(state.graphAgents);
		expect(input.message).toContain("create missing gate-lane validation runs");
	});

	it("surfaces planning-to-graph setup failures before starting a run", async () => {
		state.graphAgents = [];
		await expect(startGraphAgentRunCommand({ projectId: project.id, taskId: task.id, mode: "task_runs" })).rejects.toThrow("Create at least one agent profile first");
		expect(state.startRun).not.toHaveBeenCalled();
	});

	it("returns the active Auto Create Runs graph run instead of starting a duplicate", async () => {
		const existing = graphRun({ id: "graph-active" });
		state.runs = [existing];

		await expect(startGraphAgentRunCommand({ projectId: project.id, taskId: task.id, mode: "task_runs" })).resolves.toBe(existing);
		expect(state.startRun).not.toHaveBeenCalled();
	});

	it("deduplicates concurrent Auto Create Runs requests with an in-flight lock", async () => {
		let resolveStarted!: (run: AgentRun) => void;
		state.startRun.mockReturnValue(new Promise<AgentRun>((resolve) => {
			resolveStarted = resolve;
		}));
		const first = startGraphAgentRunCommand({ projectId: project.id, taskId: task.id, mode: "task_runs" });
		const second = startGraphAgentRunCommand({ projectId: project.id, taskId: task.id, mode: "task_runs" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(state.startRun).toHaveBeenCalledOnce();
		const created = graphRun({ id: "graph-new" });
		resolveStarted(created);

		await expect(Promise.all([first, second])).resolves.toEqual([created, created]);
	});
});
