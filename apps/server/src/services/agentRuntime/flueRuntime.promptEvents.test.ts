import type {
	Annotation,
	AgentRun,
	RunEvent,
	Task,
	Worktree,
} from "@aware/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPrompt } from "./promptBuilder";
import type { RuntimeAgent } from "./runtimeAgent";

const state = vi.hoisted(() => ({
	events: [] as Array<{
		runId: string;
		type: string;
		payload: unknown;
		options?: { immediate?: boolean };
	}>,
	annotations: [] as Annotation[],
	runs: [] as AgentRun[],
	tasks: [] as Task[],
	worktree: {
		id: "worktree-1",
		projectId: "project-1",
		path: "/workspace/project",
		branch: "feat/test",
		createdAt: "",
		updatedAt: "",
	} as Worktree,
}));

vi.mock("@flue/sdk/internal", () => ({
	createFlueContext: vi.fn(),
	resolveModel: vi.fn(),
}));

vi.mock("../../db/client", () => ({
	db: {
		insert: vi.fn(async (table: string, row: AgentRun | Task) => {
			if (table === "runs") state.runs.push(row as AgentRun);
			if (table === "tasks") state.tasks.push(row as Task);
			return row;
		}),
		list: vi.fn(async (table: string) => {
			if (table === "runs") return state.runs;
			if (table === "tasks") return state.tasks;
			return [];
		}),
		update: vi.fn(async (table: string, id: string, patch: Partial<AgentRun & Task>) => {
			const rows = table === "runs" ? state.runs : table === "tasks" ? state.tasks : [];
			const index = rows.findIndex((row) => row.id === id);
			if (index === -1) return null;
			rows[index] = { ...rows[index]!, ...patch } as never;
			return rows[index];
		}),
	},
}));

vi.mock("../annotationService", () => ({
	listAnnotations: vi.fn(async () => state.annotations),
	markAnnotationsSent: vi.fn(),
}));

vi.mock("../artifactoryService", () => ({
	buildUpstreamArtifactContext: vi.fn(async () => "prior artifact"),
	ensureSessionReportForTurn: vi.fn(),
	nextSessionReportTurnSeq: vi.fn(async () => 1),
}));

vi.mock("../skillCatalogService", () => ({
	skillSandboxPolicy: vi.fn(async () => ({})),
}));

vi.mock("../../flue/sandbox/localWorktreeSandbox", () => ({
	createDefaultEnv: vi.fn(),
	createLocalEnv: vi.fn(),
	createLocalWorktreeSandbox: vi.fn(async () => ({})),
}));

vi.mock("../defaultBranchGuard", () => ({
	revertDefaultBranchMutation: vi.fn(async () => ""),
}));
vi.mock("../gitService", () => ({ worktreeRoot: vi.fn(() => "/workspace") }));
vi.mock("../projectService", () => ({
	assertAllowedWorktree: vi.fn(async () => state.worktree),
	listProjects: vi.fn(async () => [
		{
			id: "project-1",
			name: "Project",
			rootPath: "/workspace/project",
			createdAt: "",
			updatedAt: "",
		},
	]),
}));
vi.mock("../graphAgentService", () => ({
	listGraphAgentsForRun: vi.fn(async () => []),
}));
vi.mock("../shippingAgentService", () => ({
	listMainAgentsForRun: vi.fn(async () => []),
	listShippingAgentsForRun: vi.fn(async () => []),
}));
vi.mock("../worktreeAgentService", () => ({
	ensureMutableWorktree: vi.fn(async () => state.worktree),
}));
vi.mock("../providerAuthService", () => ({
	getProviderRuntimeApiKey: vi.fn(async () => ""),
}));
vi.mock("./flueSessionStore", () => ({ flueSessionStore: {} }));
vi.mock("../../flue/tools", () => ({
	ARTIFACTORY_TOOL_NAMES: [],
	SKILL_TOOL_NAMES: ["load_skill"],
	resolveAgentTools: vi.fn(() => []),
}));
vi.mock("./runEventHub", () => ({
	runEventHub: {
		emit: vi.fn(
			(
				runId: string,
				type: string,
				payload: unknown,
				options?: { immediate?: boolean },
			) => {
				state.events.push(
					options ? { runId, type, payload, options } : { runId, type, payload },
				);
				return {
					id: `${type}-1`,
					runId,
					seq: state.events.length,
					type,
					payload,
					createdAt: "",
				} as RunEvent;
			},
		),
		flush: vi.fn(async () => undefined),
	},
}));

const { FlueRuntime, agentProfileRoleInstructions } = await import(
	"./flueRuntime"
);

describe("flue runtime prompt event shape", () => {
	const task: Task = {
		id: "task-1",
		projectId: "project-1",
		worktreeId: "worktree-1",
		title: "Fix bug",
		body: "Task body",
		status: "draft",
		createdAt: "",
		updatedAt: "",
	};
	const agents: RuntimeAgent[] = [
		{
			id: "agent-1",
			name: "Main",
			provider: "openai-codex",
			model: "openai-codex/gpt-5.5",
			thinking: "medium",
			systemPrompt: "",
			tools: [],
			createdAt: "",
			updatedAt: "",
		},
	];

	beforeEach(() => {
		vi.clearAllMocks();
		state.events = [];
		state.annotations = [];
		state.runs = [];
		state.tasks = [task];
		vi.spyOn(
			FlueRuntime.prototype as unknown as { runFlue: () => Promise<unknown> },
			"runFlue",
		).mockResolvedValue({ ok: true });
	});

	it("persists the exact built LLM prompt as the visible user_message and no duplicate prompt event", async () => {
		state.annotations = [
			{
				id: "annotation-1",
				projectId: "project-1",
				worktreeId: "worktree-1",
				kind: "file",
				filePath: "src/a.ts",
				text: "note",
				sent: false,
				createdAt: "",
				updatedAt: "",
			},
		];
		const runtime = new FlueRuntime();
		await runtime.startRun({
			task,
			worktreeId: "worktree-1",
			worktreePath: "/workspace/project",
			agents,
			message: "User request",
		});

		const expected = buildPrompt({
			task,
			agents,
			annotations: state.annotations,
			upstreamArtifacts: "prior artifact",
			message: "User request",
		});
		expect(state.events[0]).toMatchObject({
			runId: expect.any(String),
			type: "user_message",
			payload: { text: expected },
		});
		expect(state.events.map((event) => event.type)).not.toContain("prompt");
	});

	it("adds runtime instructions to agent role overlays", () => {
		const instructions = agentProfileRoleInstructions(
			"Profile prompt",
			"Global prompt",
		);

		expect(instructions).toContain("Commit as you progress");
		expect(instructions).toContain("load_skill");
		expect(instructions).toContain(".agents/skills/<skill-name>/SKILL.md");
		expect(instructions).toContain("Profile prompt");
		expect(instructions).toContain("Global prompt");
	});

	it("keeps load_skill available for allow-listed internal agents unless skills are disabled", () => {
		type TestRuntimeTool = {
			name: string;
			execute: () => Promise<unknown>;
		};
		const runtime = new FlueRuntime() as unknown as {
			applyRuntimeToolPolicy: (
				tools: TestRuntimeTool[],
				agent: RuntimeAgent,
				availableAgentRoles: string[],
			) => TestRuntimeTool[] | undefined;
		};
		const tools: TestRuntimeTool[] = [
			{ name: "graph_create_task", execute: async () => undefined },
			{ name: "load_skill", execute: async () => undefined },
			{ name: "delegate_agent", execute: async () => undefined },
			{ name: "bash", execute: async () => undefined },
		];

		expect(runtime.applyRuntimeToolPolicy(
			tools,
			{
				...agents[0]!,
				internal: true,
				allowedToolNames: ["graph_create_task"],
			},
			[],
		)?.map((tool) => tool.name)).toEqual([
			"graph_create_task",
			"load_skill",
		]);
		expect(runtime.applyRuntimeToolPolicy(
			tools,
			{
				...agents[0]!,
				internal: true,
				skillsEnabled: false,
				allowedToolNames: ["delegate_agent"],
			},
			[],
		)?.map((tool) => tool.name)).toEqual(["delegate_agent"]);
	});

	it("uses delegate_agent as an opt-in scoped delegation tool", async () => {
		type DelegateTool = {
			name: string;
			execute: (args: Record<string, unknown>) => Promise<string>;
		};
		const selected = {
			...agents[0]!,
			id: "planner",
			tools: ["delegate_agent"],
			allowedToolNames: ["delegate_agent"],
			skillsEnabled: false,
			delegationPolicy: { requiredRole: "graph-agent", minCalls: 1, maxCalls: 1 },
		} as RuntimeAgent;
		const graphAgent: RuntimeAgent = {
			...agents[0]!,
			id: "graph",
			name: "Graph Agent",
			roleName: "graph-agent",
			tools: ["graph_start_run"],
			allowedToolNames: ["graph_start_run"],
			skillsEnabled: false,
		};
		const runtime = new FlueRuntime() as unknown as {
			createScopedDelegationTools: (run: AgentRun, input: unknown, agents: RuntimeAgent[]) => DelegateTool[];
			runDelegatedAgent: ReturnType<typeof vi.fn>;
		};
		runtime.runDelegatedAgent = vi.fn(async () => ({ text: "delegated" }));
		const run: AgentRun = {
			id: "run-1",
			taskId: task.id,
			projectId: task.projectId,
			worktreeId: "worktree-1",
			status: "running",
			sessionId: "session-1",
			startedAt: "",
		};

		const tools = runtime.createScopedDelegationTools(run, {
			task,
			worktreeId: "worktree-1",
			worktreePath: "/workspace/project",
			agents: [selected, graphAgent],
		}, [graphAgent]);

		expect(tools.map((tool) => tool.name)).toEqual(["delegate_agent"]);
		await expect(tools[0]!.execute({ role: "graph-agent", prompt: "plan" })).resolves.toBe("delegated");
		await expect(tools[0]!.execute({ role: "graph-agent", prompt: "plan again" })).rejects.toThrow(/exactly once/i);
		expect(runtime.runDelegatedAgent).toHaveBeenCalledWith(expect.objectContaining({ id: run.id }), expect.objectContaining({ agents: [selected, graphAgent] }), graphAgent, "plan");
		expect(runtime.runDelegatedAgent).toHaveBeenCalledOnce();
		expect(runtime.createScopedDelegationTools(run, { task, worktreeId: "worktree-1", worktreePath: "/workspace/project", agents }, [graphAgent])).toEqual([]);
	});

	it("creates a read-only delegated child run with isolated child events and parent link", async () => {
		const runtime = new FlueRuntime() as unknown as {
			runDelegatedAgent: (parentRun: AgentRun, input: unknown, agent: RuntimeAgent, prompt: string, description?: string) => Promise<unknown>;
		};
		const parentRun: AgentRun = {
			id: "parent-run",
			taskId: task.id,
			projectId: task.projectId,
			worktreeId: "worktree-1",
			status: "running",
			sessionId: "session-parent",
			startedAt: "",
		};
		state.runs = [parentRun];
		const exploreAgent: RuntimeAgent = {
			...agents[0]!,
			id: "explore",
			name: "Explore Agent",
			roleName: "explore-agent",
			tools: ["read"],
			allowedToolNames: ["read"],
			skillsEnabled: false,
		};

		const result = await runtime.runDelegatedAgent(parentRun, {
			task,
			worktreeId: "worktree-1",
			worktreePath: "/workspace/project",
			agents: [agents[0]!, exploreAgent],
		}, exploreAgent, "inspect code", "Discovery");

		const child = state.runs.find((run) => run.id !== parentRun.id)!;
		expect(child).toMatchObject({
			parentRunId: parentRun.id,
			origin: "delegate_agent",
			readOnly: true,
			affectsTaskStatus: false,
			delegateRole: "explore-agent",
			delegateDescription: "Discovery",
			delegateToolCallId: expect.any(String),
			mainAgentName: "Explore Agent",
			status: "done",
		});
		expect(state.events.filter((event) => event.runId === parentRun.id).map((event) => event.type)).toEqual(["task_start", "task_end"]);
		expect(state.events.filter((event) => event.runId === child.id).map((event) => event.type)).toEqual(["user_message", "result"]);
		expect(result).toMatchObject({
			childRunId: child.id,
			childRunHref: `/projects/${task.projectId}/tasks/${task.id}/runs/${child.id}`,
			role: "explore-agent",
			status: "done",
		});
	});

	it("returns delegated child metadata when a child run fails", async () => {
		const runtime = new FlueRuntime() as unknown as {
			runDelegatedAgent: (parentRun: AgentRun, input: unknown, agent: RuntimeAgent, prompt: string, description?: string) => Promise<unknown>;
		};
		vi.spyOn(
			FlueRuntime.prototype as unknown as { runFlue: () => Promise<unknown> },
			"runFlue",
		).mockRejectedValueOnce(new Error("child failed"));
		const parentRun: AgentRun = {
			id: "parent-failed",
			taskId: task.id,
			projectId: task.projectId,
			worktreeId: "worktree-1",
			status: "running",
			sessionId: "session-parent-failed",
			startedAt: "",
		};
		state.runs = [parentRun];
		const exploreAgent: RuntimeAgent = {
			...agents[0]!,
			id: "explore",
			name: "Explore Agent",
			roleName: "explore-agent",
			tools: ["read"],
			allowedToolNames: ["read"],
			skillsEnabled: false,
		};

		const result = await runtime.runDelegatedAgent(parentRun, {
			task,
			worktreeId: "worktree-1",
			worktreePath: "/workspace/project",
			agents: [agents[0]!, exploreAgent],
		}, exploreAgent, "inspect code", "Discovery");
		const child = state.runs.find((run) => run.id !== parentRun.id)!;

		expect(child.status).toBe("failed");
		expect(result).toMatchObject({
			childRunId: child.id,
			childRunHref: `/projects/${task.projectId}/tasks/${task.id}/runs/${child.id}`,
			role: "explore-agent",
			status: "failed",
			result: "child failed",
		});
		expect(state.events.filter((event) => event.runId === parentRun.id).at(-1)).toMatchObject({
			type: "task_end",
			payload: expect.objectContaining({ childRunId: child.id, status: "failed", result: "child failed" }),
		});
	});

	it("enforces delegation matrix, self-delegation block, and max-call limits", async () => {
		type DelegateTool = { name: string; execute: (args: Record<string, unknown>) => Promise<string> };
		const runtime = new FlueRuntime() as unknown as {
			createScopedDelegationTools: (run: AgentRun, input: unknown, agents: RuntimeAgent[]) => DelegateTool[];
			runDelegatedAgent: ReturnType<typeof vi.fn>;
		};
		runtime.runDelegatedAgent = vi.fn(async () => ({ text: "ok" }));
		const run: AgentRun = {
			id: "run-1", taskId: task.id, projectId: task.projectId, worktreeId: "worktree-1", status: "running", sessionId: "session-1", startedAt: "",
		};
		const explore: RuntimeAgent = { ...agents[0]!, id: "explore", name: "Explore Agent", roleName: "explore-agent", tools: [], systemPrompt: "" };
		const review: RuntimeAgent = { ...agents[0]!, id: "review", name: "Review Agent", roleName: "review-agent", tools: ["delegate_agent"], delegationPolicy: { allowedRoles: ["explore-agent"] } };
		const test: RuntimeAgent = { ...agents[0]!, id: "test", name: "Test Agent", roleName: "test-agent", tools: ["delegate_agent"], delegationPolicy: { allowedRoles: ["explore-agent"] } };
		const custom: RuntimeAgent = { ...agents[0]!, id: "custom", name: "Custom", roleName: "agent-custom-123", tools: ["delegate_agent"], delegationPolicy: { allowedRoles: ["explore-agent"] } };
		const main: RuntimeAgent = { ...agents[0]!, id: "main", name: "Main", roleName: "main", tools: ["delegate_agent"], delegationPolicy: { maxCalls: 1 } };

		for (const selected of [review, test, custom]) {
			const tools = runtime.createScopedDelegationTools(run, { task, worktreeId: "worktree-1", worktreePath: "/workspace/project", agents: [selected, explore, main] }, [explore, main]);
			await expect(tools[0]!.execute({ role: "explore-agent", prompt: "x" })).resolves.toBe("ok");
			await expect(tools[0]!.execute({ role: "main", prompt: "x" })).rejects.toThrow(/not allowed|not available/);
		}
		const mainTools = runtime.createScopedDelegationTools({ ...run, id: "run-2" }, { task, worktreeId: "worktree-1", worktreePath: "/workspace/project", agents: [main, explore] }, [explore]);
		await expect(mainTools[0]!.execute({ role: "main", prompt: "x" })).rejects.toThrow(/not available|current agent/);
		await expect(mainTools[0]!.execute({ role: "explore-agent", prompt: "x" })).resolves.toBe("ok");
		await expect(mainTools[0]!.execute({ role: "explore-agent", prompt: "x" })).rejects.toThrow(/limit reached/);
	});

	it("does not expose the legacy task tool in runtime sessions", async () => {
		(
			FlueRuntime.prototype as unknown as {
				runFlue: { mockRestore: () => void };
			}
		).runFlue.mockRestore();
		const { createFlueContext } = await import("@flue/sdk/internal");
		const { resolveAgentTools } = await import("../../flue/tools");
		vi.mocked(resolveAgentTools).mockReturnValue([
			{ name: "task", description: "legacy task", parameters: {}, execute: vi.fn() },
			{ name: "read", description: "read", parameters: {}, execute: vi.fn() },
		] as never);
		let initTools: Array<{ name: string }> = [];
		vi.mocked(createFlueContext).mockReturnValue({
			setEventCallback: vi.fn(),
			init: vi.fn(async (options: { tools: Array<{ name: string }> }) => {
				initTools = options.tools;
				return {
					session: vi.fn(async () => ({
						harness: { state: { tools: initTools } },
						prompt: vi.fn(async () => "ok"),
					})),
				};
			}),
		} as never);
		const runtime = new FlueRuntime() as unknown as {
			runFlue: (run: AgentRun, input: unknown, prompt: string) => Promise<unknown>;
		};
		const selected: RuntimeAgent = {
			...agents[0]!,
			tools: ["task", "read", "delegate_agent"],
		};
		const explore: RuntimeAgent = {
			...agents[0]!,
			id: "explore",
			name: "Explore Agent",
			roleName: "explore-agent",
			tools: ["read"],
		};
		const run: AgentRun = {
			id: "run-task-filter", taskId: task.id, projectId: task.projectId, worktreeId: "worktree-1", status: "running", sessionId: "session-task-filter", startedAt: "",
		};

		await runtime.runFlue(run, { task, worktreeId: "worktree-1", worktreePath: "/workspace/project", agents: [selected, explore] }, "prompt");

		expect(initTools.map((tool) => tool.name)).not.toContain("task");
		expect(initTools.map((tool) => tool.name)).toContain("delegate_agent");
	});

	it("fails scoped planner runs that return without required delegation", async () => {
		(
			FlueRuntime.prototype as unknown as {
				runFlue: { mockRestore: () => void };
			}
		).runFlue.mockRestore();
		const { createFlueContext } = await import("@flue/sdk/internal");
		vi.mocked(createFlueContext).mockReturnValue({
			setEventCallback: vi.fn(),
			init: vi.fn(async () => ({
				session: vi.fn(async () => ({
					harness: { state: { tools: [] } },
					prompt: vi.fn(async () => "finished without delegating"),
				})),
			})),
		} as never);
		const runtime = new FlueRuntime() as unknown as {
			runFlue: (run: AgentRun, input: unknown, prompt: string) => Promise<unknown>;
		};
		const selected = {
			...agents[0]!,
			id: "planner",
			tools: ["delegate_agent"],
			allowedToolNames: ["delegate_agent"],
			skillsEnabled: false,
			delegationPolicy: { requiredRole: "graph-agent", minCalls: 1, maxCalls: 1 },
		} as RuntimeAgent;
		const graphAgent: RuntimeAgent = {
			...agents[0]!,
			id: "graph",
			name: "Graph Agent",
			roleName: "graph-agent",
			tools: ["graph_start_execution_plan"],
			allowedToolNames: ["graph_start_execution_plan"],
			skillsEnabled: false,
		};
		const run: AgentRun = {
			id: "run-1",
			taskId: task.id,
			projectId: task.projectId,
			worktreeId: "worktree-1",
			status: "running",
			sessionId: "session-1",
			startedAt: "",
		};

		await expect(runtime.runFlue(run, {
			task,
			worktreeId: "worktree-1",
			worktreePath: "/workspace/project",
			agents: [selected, graphAgent],
		}, "plan prompt")).rejects.toThrow(/exactly once/i);
	});

	it("queues sequential children until the parent run is marked done", async () => {
		state.runs = [
			{
				id: "parent-run",
				taskId: task.id,
				projectId: task.projectId,
				worktreeId: "worktree-1",
				status: "need_review",
				sessionId: "session-parent",
				startedAt: "",
			},
		];
		const runtime = new FlueRuntime();
		const queueRuntime = runtime as unknown as {
			activateQueuedSequentialChildren: (parentRunId: string) => Promise<void>;
			markRunDoneAndActivateChildren: (runId: string) => Promise<AgentRun | null>;
		};
		const runFlueMock = (
			FlueRuntime.prototype as unknown as {
				runFlue: { mock: { calls: unknown[][] } };
			}
		).runFlue;

		const child = await runtime.startRun({
			task,
			worktreeId: "worktree-1",
			worktreePath: "/workspace/project",
			agents,
			message: "Run after parent.",
			relation: "sequential",
			parentRunId: "parent-run",
		});

		expect(child.status).toBe("queued");
		expect(runFlueMock.mock.calls).toHaveLength(0);

		await queueRuntime.activateQueuedSequentialChildren("parent-run");
		expect(runFlueMock.mock.calls).toHaveLength(0);

		await queueRuntime.markRunDoneAndActivateChildren("parent-run");
		expect(state.runs.find((run) => run.id === child.id)?.status).toBe("running");
		expect(runFlueMock.mock.calls).toHaveLength(1);
		expect(runFlueMock.mock.calls[0]![0]).toMatchObject({ id: child.id });
	});

	it("continues runs with only the typed user message", async () => {
		state.runs = [
			{
				id: "run-1",
				taskId: task.id,
				projectId: task.projectId,
				worktreeId: "worktree-1",
				status: "running",
				sessionId: "session-1",
				startedAt: "",
			},
		];
		const runtime = new FlueRuntime();

		await runtime.continueRun("run-1", "Follow up only");

		expect(state.events[0]).toMatchObject({
			runId: expect.any(String),
			type: "user_message",
			payload: { text: "Follow up only" },
		});
		expect(JSON.stringify(state.events)).not.toContain("Upstream Artifactory");
		expect(JSON.stringify(state.events)).not.toContain("Project id");
		const runFlueMock = (
			FlueRuntime.prototype as unknown as {
				runFlue: { mock: { calls: unknown[][] } };
			}
		).runFlue;
		expect(runFlueMock.mock.calls.at(-1)?.[2]).toBe("Follow up only");
	});
});
