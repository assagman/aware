import type { Annotation, AgentRun, RunEvent, Task, Worktree } from "@aware/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPrompt } from "./promptBuilder";
import type { RuntimeAgent } from "./runtimeAgent";

const state = vi.hoisted(() => ({
	events: [] as Array<{ type: string; payload: unknown; options?: { immediate?: boolean } }>,
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
		update: vi.fn(async () => ({})),
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

vi.mock("../defaultBranchGuard", () => ({ revertDefaultBranchMutation: vi.fn(async () => "") }));
vi.mock("../gitService", () => ({ worktreeRoot: vi.fn(() => "/workspace") }));
vi.mock("../projectService", () => ({
	assertAllowedWorktree: vi.fn(async () => state.worktree),
	listProjects: vi.fn(async () => [{ id: "project-1", name: "Project", rootPath: "/workspace/project", createdAt: "", updatedAt: "" }]),
}));
vi.mock("../graphAgentService", () => ({ listGraphAgentsForRun: vi.fn(async () => []) }));
vi.mock("../shippingAgentService", () => ({
	listMainAgentsForRun: vi.fn(async () => []),
	listShippingAgentsForRun: vi.fn(async () => []),
}));
vi.mock("../worktreeAgentService", () => ({ ensureMutableWorktree: vi.fn(async () => state.worktree) }));
vi.mock("../providerAuthService", () => ({ getProviderRuntimeApiKey: vi.fn(async () => "") }));
vi.mock("./flueSessionStore", () => ({ flueSessionStore: {} }));
vi.mock("../../flue/tools", () => ({ ARTIFACTORY_TOOL_NAMES: [], resolveAgentTools: vi.fn(() => []) }));
vi.mock("./runEventHub", () => ({
	runEventHub: {
		emit: vi.fn((runId: string, type: string, payload: unknown, options?: { immediate?: boolean }) => {
			state.events.push(options ? { type, payload, options } : { type, payload });
			return { id: `${type}-1`, runId, seq: state.events.length, type, payload, createdAt: "" } as RunEvent;
		}),
		flush: vi.fn(async () => undefined),
	},
}));

const { FlueRuntime, agentProfileRoleInstructions } = await import("./flueRuntime");

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
	const agents: RuntimeAgent[] = [{
		id: "agent-1",
		name: "Main",
		provider: "openai-codex",
		model: "openai-codex/gpt-5.5",
		thinking: "medium",
		systemPrompt: "",
		tools: [],
		createdAt: "",
		updatedAt: "",
	}];

	beforeEach(() => {
		vi.clearAllMocks();
		state.events = [];
		state.annotations = [];
		state.runs = [];
		state.tasks = [task];
		vi.spyOn(FlueRuntime.prototype as unknown as { runFlue: () => Promise<unknown> }, "runFlue").mockResolvedValue({ ok: true });
	});

	it("persists the exact built LLM prompt as the visible user_message and no duplicate prompt event", async () => {
		state.annotations = [{ id: "annotation-1", projectId: "project-1", worktreeId: "worktree-1", kind: "file", filePath: "src/a.ts", text: "note", sent: false, createdAt: "", updatedAt: "" }];
		const runtime = new FlueRuntime();
		await runtime.startRun({ task, worktreeId: "worktree-1", worktreePath: "/workspace/project", agents, message: "User request" });

		const expected = buildPrompt({ task, agents, annotations: state.annotations, upstreamArtifacts: "prior artifact", message: "User request" });
		expect(state.events[0]).toMatchObject({ type: "user_message", payload: { text: expected } });
		expect(state.events.map((event) => event.type)).not.toContain("prompt");
	});

	it("adds runtime instructions to agent role overlays", () => {
		const instructions = agentProfileRoleInstructions("Profile prompt", "Global prompt");

		expect(instructions).toContain("Commit as you progress");
		expect(instructions).toContain(".agents/skills/<skill-name>/SKILL.md");
		expect(instructions).toContain("Profile prompt");
		expect(instructions).toContain("Global prompt");
	});

	it("continues runs with only the typed user message", async () => {
		state.runs = [{
			id: "run-1",
			taskId: task.id,
			projectId: task.projectId,
			worktreeId: "worktree-1",
			status: "running",
			sessionId: "session-1",
			startedAt: "",
		}];
		const runtime = new FlueRuntime();

		await runtime.continueRun("run-1", "Follow up only");

		expect(state.events[0]).toMatchObject({ type: "user_message", payload: { text: "Follow up only" } });
		expect(JSON.stringify(state.events)).not.toContain("Upstream Artifactory");
		expect(JSON.stringify(state.events)).not.toContain("Project id");
		const runFlueMock = (FlueRuntime.prototype as unknown as { runFlue: { mock: { calls: unknown[][] } } }).runFlue;
		expect(runFlueMock.mock.calls.at(-1)?.[2]).toBe("Follow up only");
	});
});
