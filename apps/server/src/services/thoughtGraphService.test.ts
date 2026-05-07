import type { AgentRun, RunArtifact, RunEvent, Task, ThoughtGraph } from "@aware/shared";
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
	currentThoughtGraphAnalyzerInput,
	generateThoughtGraph,
	getCachedThoughtGraph,
	thoughtGraphSourceHash,
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

const thoughtAgent: RuntimeAgent = {
	id: "thought",
	name: "Thought",
	provider: "openai-codex",
	model: "openai-codex/gpt-5.5",
	thinking: "xhigh",
	systemPrompt: "",
	tools: [],
};

function event(seq: number, type: string, payload: unknown): RunEvent {
	return {
		id: `event-${seq}`,
		runId: run.id,
		seq,
		type,
		payload,
		createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
	};
}

function graph(summary = "LLM distilled graph."): ThoughtGraph {
	return {
		version: 1,
		runId: run.id,
		sourceEventSeqRange: [1, Math.max(...rows.runEvents.map((item) => item.seq))],
		sourceEventHash: thoughtGraphSourceHash(rows.runEvents),
		summary,
		nodes: [
			{ id: "intent", kind: "intent", label: "User goal", detail: "Debug thought graph", phase: "User intent", sourceEventIds: ["event-1"] },
			{ id: "decision", kind: "decision", label: "Show distilled graph", detail: "Hide noisy raw inputs from graph output.", phase: "Decisions", sourceEventIds: ["event-2"] },
		],
		edges: [{ id: "e1", source: "intent", target: "decision", kind: "led_to" }],
		timeline: [{ seq: 2, type: "insight", title: "Decision", detail: "Show distilled graph", eventId: "event-2" }],
		insights: [{ kind: "summary", text: summary, nodeIds: ["decision"] }],
		risks: [],
		openQuestions: [],
		generatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function saveGraphArtifact(body = graph()) {
	rows.runArtifacts.push({
		id: `thought-graph:${run.id}`,
		projectId: task.projectId,
		taskId: task.id,
		runId: run.id,
		worktreeId: run.worktreeId,
		kind: "thought_graph",
		turnSeq: 1,
		title: "Thought graph",
		body: JSON.stringify(body),
		metadata: { source: "thought-agent" },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	});
}

describe("thought graph service", () => {
	beforeEach(() => {
		rows.tasks = [task];
		rows.runs = [run];
		rows.runArtifacts = [];
		rows.runEvents = [
			event(1, "user_message", { text: "Implement graph" }),
			event(2, "thinking_delta_batch", { text: "Decision: use LLM analyzer. Risk: raw tool calls may overwhelm output." }),
			event(3, "tool_start", { toolName: "read", args: { path: "src/a.ts" } }),
			event(4, "tool_end", { toolName: "read", result: "found API" }),
			event(5, "turn_end", { turn: 1 }),
			event(6, "artifact_saved", { artifactId: `session-report:${run.id}:1`, kind: "session_report", title: "Turn 1 session report" }),
		];
		startRun.mockReset();
		listThoughtAgentsForRun.mockReset();
		listThoughtAgentsForRun.mockResolvedValue([]);
		assertAllowedWorktree.mockClear();
	});

	it("passes full run inputs, tool calls, and artifacts to ThoughtAgent", async () => {
		rows.runArtifacts.push({
			id: `session-report:${run.id}:1`,
			projectId: task.projectId,
			taskId: task.id,
			runId: run.id,
			worktreeId: run.worktreeId,
			kind: "session_report",
			turnSeq: 1,
			title: "Turn 1 session report",
			body: "Tool call: read src/a.ts",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		rows.runEvents.push(event(7, "artifact_saved", { artifactId: `thought-graph:${run.id}`, kind: "thought_graph", title: "Thought graph" }));

		const input = await currentThoughtGraphAnalyzerInput(run.id);

		expect(input.events.map((item) => item.type)).toEqual(["user_message", "thinking_delta_batch", "tool_start", "tool_end", "turn_end", "artifact_saved"]);
		expect(JSON.stringify(input.events)).toContain("found API");
		expect(JSON.stringify(input.artifacts)).toContain("Turn 1 session report");
		expect(JSON.stringify(input)).not.toContain(`thought-graph:${run.id}`);
	});

	it("requires ThoughtAgent and never saves deterministic fallback", async () => {
		await expect(generateThoughtGraph(run.id)).rejects.toThrow("ThoughtAgent unavailable");

		expect(startRun).not.toHaveBeenCalled();
		expect(rows.runArtifacts).toEqual([]);
	});

	it("returns the graph saved by the LLM ThoughtAgent", async () => {
		listThoughtAgentsForRun.mockResolvedValueOnce([thoughtAgent]);
		startRun.mockImplementationOnce(async () => {
			saveGraphArtifact(graph("LLM-only insight graph."));
			return { ...run, id: "analysis-run", lane: "graph", parentRunId: run.id };
		});

		const saved = await generateThoughtGraph(run.id);

		expect(saved.summary).toBe("LLM-only insight graph.");
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

	it("fails instead of generating fallback when ThoughtAgent does not save a graph", async () => {
		listThoughtAgentsForRun.mockResolvedValueOnce([thoughtAgent]);
		startRun.mockResolvedValueOnce({ ...run, id: "analysis-run", lane: "graph", parentRunId: run.id });

		await expect(generateThoughtGraph(run.id)).rejects.toThrow("ThoughtAgent did not save thought graph");

		expect(rows.runArtifacts).toEqual([]);
	});

	it("invalidates cached graph when any non-self source event changes", async () => {
		saveGraphArtifact();

		const cached = await getCachedThoughtGraph(run.id);
		expect(cached.stale).toBe(false);

		rows.runEvents.push(event(7, "artifact_saved", { artifactId: `thought-graph:${run.id}`, kind: "thought_graph", title: "Thought graph" }));
		expect((await getCachedThoughtGraph(run.id)).stale).toBe(false);

		rows.runEvents.push(event(8, "artifact_saved", { artifactId: `session-report:${run.id}:2`, kind: "session_report", title: "Turn 2 session report" }));
		expect((await getCachedThoughtGraph(run.id)).stale).toBe(true);
	});
});
