import type { AgentRun, RunArtifact, RunEvent, Task } from "@aware/shared";
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

const {
	buildDeterministicThoughtGraph,
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
	});

	it("builds graph with decisions, pivots, evidence, risks, and outcome", () => {
		const graph = buildDeterministicThoughtGraph({ run, events: rows.runEvents, artifacts: [] });

		expect(graph.nodes.some((node) => node.kind === "decision")).toBe(true);
		expect(graph.nodes.some((node) => node.kind === "pivot")).toBe(true);
		expect(graph.nodes.some((node) => node.kind === "evidence")).toBe(true);
		expect(graph.nodes.some((node) => node.kind === "risk")).toBe(true);
		expect(graph.nodes.some((node) => node.kind === "outcome")).toBe(true);
		expect(graph.summary).toContain("Synthesized");
	});

	it("saves and invalidates cached graph when events change", async () => {
		const saved = await generateThoughtGraph(run.id);
		expect(saved.runId).toBe(run.id);
		expect(rows.runArtifacts[0]?.kind).toBe("thought_graph");

		const cached = await getCachedThoughtGraph(run.id);
		expect(cached.stale).toBe(false);
		expect(cached.graph?.sourceEventHash).toBe(saved.sourceEventHash);

		rows.runEvents.push(event(7, "tool_end", { toolName: "test", result: "pass" }));
		const stale = await getCachedThoughtGraph(run.id);
		expect(stale.stale).toBe(true);
	});

	it("falls back when thinking is empty", () => {
		const graph = buildDeterministicThoughtGraph({
			run,
			events: [event(1, "user_message", { text: "Do it" }), event(2, "tool_start", { toolName: "read" })],
			artifacts: [],
		});

		expect(graph.nodes.some((node) => node.kind === "decision")).toBe(true);
		expect(graph.nodes.some((node) => node.kind === "risk")).toBe(true);
		expect(graph.nodes.some((node) => node.kind === "outcome")).toBe(true);
	});
});
