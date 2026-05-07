import type { AgentRun, RunArtifact, RunEvent, Task } from "@aware/shared";
import type { RuntimeAgent } from "./agentRuntime/runtimeAgent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: {
	tasks: Task[];
	runs: AgentRun[];
	runArtifacts: RunArtifact[];
	runEvents: RunEvent[];
} = {
	tasks: [],
	runs: [],
	runArtifacts: [],
	runEvents: [],
};

const startRun = vi.fn();
const listThoughtAgentsForRun = vi.fn<() => Promise<RuntimeAgent[]>>(async () => []);
const assertAllowedWorktree = vi.fn(async () => ({ id: "worktree-1", path: "/workspace/project" }));

vi.mock("../db/client", () => ({
	db: {
		list: vi.fn(async (table: keyof typeof rows) => rows[table]),
		insert: vi.fn(async (table: keyof typeof rows, row: { id: string }) => {
			const tableRows = rows[table] as { id: string }[];
			const existing = tableRows.findIndex((item) => item.id === row.id);
			if (existing >= 0) tableRows[existing] = row;
			else tableRows.push(row);
			return row;
		}),
	},
}));

vi.mock("./agentRuntime/runEventHub", () => ({
	runEventHub: {
		emit: vi.fn(),
		flush: vi.fn(async () => undefined),
		persistedEvents: vi.fn(async (runId: string) => rows.runEvents.filter((event) => event.runId === runId)),
	},
}));

vi.mock("./agentRuntime/flueRuntime", () => ({
	flueRuntime: { startRun },
}));

vi.mock("./thoughtAgentService", () => ({
	listThoughtAgentsForRun,
}));

vi.mock("./projectService", () => ({
	assertAllowedWorktree,
}));

const {
	buildDeterministicThoughtGraph,
	buildThoughtGraphAnalyzerInput,
	generateThoughtGraph,
	getCachedThoughtGraph,
} = await import("./thoughtGraphService");

const task: Task = {
	id: "task-1",
	projectId: "project-1",
	worktreeId: "worktree-1",
	title: "Task",
	body: "Body",
	status: "running",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const run: AgentRun = {
	id: "run-1",
	taskId: task.id,
	projectId: task.projectId,
	worktreeId: "worktree-1",
	status: "done",
	sessionId: "session-1",
	startedAt: "2026-01-01T00:00:00.000Z",
};

function event(seq: number, type: string, payload: unknown): RunEvent {
	return {
		id: `event-${seq}`,
		runId: run.id,
		seq,
		type,
		payload,
		createdAt: `2026-01-01T00:00:0${seq}.000Z`,
	};
}

describe("thought graph service", () => {
	beforeEach(() => {
		rows.tasks = [task];
		rows.runs = [run];
		rows.runArtifacts = [];
		rows.runEvents = [
			event(1, "user_message", { text: "Implement graph" }),
			event(2, "thinking_delta_batch", { text: "Decision: use deterministic analyzer first. Risk: invalid thinking may be empty." }),
			event(3, "tool_start", { toolName: "read", args: { path: "src/a.ts" } }),
			event(4, "tool_end", { toolName: "read", result: "found API" }),
			event(5, "thinking_delta_batch", { text: "Pivot: switch to cached artifact after schema work." }),
			event(6, "message_delta_batch", { text: "Done with final direction." }),
		];
		startRun.mockReset();
		listThoughtAgentsForRun.mockReset();
		listThoughtAgentsForRun.mockResolvedValue([]);
		assertAllowedWorktree.mockClear();
	});

	it("builds graph with decisions, pivots, risks, concrete actions, and outcome", () => {
		const graph = buildDeterministicThoughtGraph({ run, events: rows.runEvents, artifacts: [] });

		expect(graph.nodes.some((node) => node.kind === "decision")).toBe(true);
		expect(graph.nodes.some((node) => node.kind === "pivot")).toBe(true);
		expect(graph.nodes.some((node) => node.kind === "risk")).toBe(true);
		expect(graph.nodes.some((node) => node.kind === "action")).toBe(true);
		expect(graph.nodes.some((node) => node.kind === "outcome")).toBe(true);
		expect(graph.summary).toContain("distilled");
	});

	it("saves and invalidates cached graph when events change", async () => {
		const saved = await generateThoughtGraph(run.id);
		expect(saved.runId).toBe(run.id);
		expect(startRun).not.toHaveBeenCalled();
		expect(rows.runArtifacts[0]?.kind).toBe("thought_graph");

		const cached = await getCachedThoughtGraph(run.id);
		expect(cached.stale).toBe(false);
		expect(cached.graph?.sourceEventHash).toBe(saved.sourceEventHash);

		rows.runEvents.push(event(7, "artifact_saved", { artifactId: `thought-graph:${run.id}`, kind: "thought_graph", title: "Thought graph" }));
		const selfArtifactEvent = await getCachedThoughtGraph(run.id);
		expect(selfArtifactEvent.stale).toBe(false);

		rows.runEvents.push(event(8, "artifact_saved", { artifactId: `session-report:${run.id}:1`, kind: "session_report", title: "Turn 1 session report" }));
		const sessionReportEvent = await getCachedThoughtGraph(run.id);
		expect(sessionReportEvent.stale).toBe(false);

		rows.runEvents.push(event(9, "tool_end", { toolName: "test", result: "pass" }));
		const stale = await getCachedThoughtGraph(run.id);
		expect(stale.stale).toBe(true);
	});

	it("skips turn session artifacts and raw tool event noise", () => {
		const graph = buildDeterministicThoughtGraph({
			run,
			events: [
				event(1, "user_message", { text: "Debug thought graph" }),
				event(2, "thinking_delta_batch", { text: "Hypothesis: session reports are leaking. Decision: filter turn artifacts and keep concrete actions only." }),
				event(3, "tool_start", { toolName: "context_mode_ctx_execute", args: { command: "rg thoughtGraph apps/server/src" } }),
				event(4, "tool_end", { toolName: "context_mode_ctx_execute", result: "500 lines of tool output" }),
				event(5, "message_delta_batch", { text: "Found graph service root cause." }),
			],
			artifacts: [{
				id: "session-report:run-1:1",
				projectId: task.projectId,
				taskId: task.id,
				runId: run.id,
				worktreeId: run.worktreeId,
				kind: "session_report",
				turnSeq: 1,
				title: "Turn 1 session report",
				body: "Tool call: context_mode_ctx_execute\nTurn artifact body should not become graph evidence.",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			}],
		});

		const serialized = JSON.stringify({ nodes: graph.nodes, timeline: graph.timeline });
		expect(serialized).not.toContain("Turn 1");
		expect(serialized).not.toContain("tool_start");
		expect(serialized).not.toContain("tool_end");
		expect(graph.nodes.length).toBeLessThanOrEqual(8);
	});

	it("sanitizes ThoughtAgent input away from upstream Turn artifacts", () => {
		const input = buildThoughtGraphAnalyzerInput({
			events: [
				event(1, "user_message", { text: "## User request\nDebug graph\n\n## Upstream Artifactory\n### Turn 1 session report\nTool call: read" }),
				event(2, "thinking_delta_batch", { text: "Decision: inspect source thinking only." }),
			],
			artifacts: [{
				id: "session-report:run-1:1",
				projectId: task.projectId,
				taskId: task.id,
				runId: run.id,
				worktreeId: run.worktreeId,
				kind: "session_report",
				turnSeq: 1,
				title: "Turn 1 session report",
				body: "Tool call: read",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			}],
		});

		const serialized = JSON.stringify(input);
		expect(serialized).not.toContain("Turn 1");
		expect(serialized).not.toContain("Upstream Artifactory");
		expect(input.omitted.sessionArtifacts).toBe(1);
	});

	it("does not invent pivots, risks, or follow-ups when source has none", () => {
		const graph = buildDeterministicThoughtGraph({
			run,
			events: [
				event(1, "user_message", { text: "Improve graph readability" }),
				event(2, "thinking_delta_batch", { text: "Decision: keep nodes focused on reasoning." }),
				event(3, "message_delta_batch", { text: "Applied focused graph direction." }),
			],
			artifacts: [],
		});

		expect(graph.nodes.filter((node) => node.kind === "pivot")).toHaveLength(0);
		expect(graph.nodes.filter((node) => node.kind === "risk")).toHaveLength(0);
		expect(graph.nodes.filter((node) => node.kind === "follow_up")).toHaveLength(0);
		expect(graph.openQuestions).toEqual([]);
	});

	it("runs the ThoughtAgent analyzer when available and returns its saved graph", async () => {
		listThoughtAgentsForRun.mockResolvedValueOnce([{ id: "thought", name: "Thought", provider: "zai", model: "zai/glm-5.1", systemPrompt: "", tools: [] }]);
		startRun.mockImplementationOnce(async () => {
			const graph = buildDeterministicThoughtGraph({ run, events: rows.runEvents, artifacts: [] });
			rows.runArtifacts.push({
				id: `thought-graph:${run.id}`,
				projectId: task.projectId,
				taskId: task.id,
				runId: run.id,
				worktreeId: run.worktreeId,
				kind: "thought_graph",
				turnSeq: 1,
				title: "Thought graph",
				body: JSON.stringify({ ...graph, summary: "LLM distilled graph." }),
				metadata: { source: "thought-agent" },
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			});
			return { ...run, id: "analysis-run", lane: "graph", parentRunId: run.id };
		});

		const graph = await generateThoughtGraph(run.id);

		expect(graph.summary).toBe("LLM distilled graph.");
		expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
			lane: "graph",
			parentRunId: run.id,
			affectsTaskStatus: false,
			completedStatus: "done",
			thoughtTargetRunId: run.id,
			waitForCompletion: true,
			suppressUpstreamArtifacts: true,
		}));
	});
});
