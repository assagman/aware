import type { AgentRun, ThoughtGraph } from "@aware/shared";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const run: AgentRun = {
	id: "run-1",
	taskId: "task-1",
	projectId: "project-1",
	worktreeId: "worktree-1",
	status: "done",
	sessionId: "session-1",
	startedAt: "2026-01-01T00:00:00.000Z",
};

const graph: ThoughtGraph = {
	version: 1,
	runId: run.id,
	sourceEventSeqRange: [1, 1],
	sourceEventHash: "sha256:test",
	summary: "Cached graph.",
	nodes: [],
	edges: [],
	timeline: [],
	insights: [],
	risks: [],
	openQuestions: [],
	generatedAt: "2026-01-01T00:00:00.000Z",
};

const dbList = vi.fn();
const dbUpdate = vi.fn();
const getCachedThoughtGraph = vi.fn();
const generateThoughtGraph = vi.fn();

vi.mock("../db/client", () => ({
	db: {
		list: dbList,
		update: dbUpdate,
	},
}));

vi.mock("../services/thoughtGraphService", () => ({
	getCachedThoughtGraph,
	generateThoughtGraph,
}));

vi.mock("../services/agentRuntime/flueRuntime", () => ({
	flueRuntime: { continueRun: vi.fn() },
	runInactivityTimeoutMs: () => 300_000,
}));

vi.mock("../services/agentRuntime/runEventHub", () => ({
	MAX_QUEUE_EVENTS: 512,
	runEventHub: {
		emit: vi.fn(),
		persistedEvents: vi.fn(async () => []),
		hydrateRun: vi.fn(),
		subscribe: vi.fn(() => () => undefined),
	},
}));

vi.mock("../services/taskService", () => ({
	allTaskRunsDone: vi.fn(async () => false),
}));

const { runs } = await import("./runs");

function app() {
	return new Hono().route("/api/runs", runs);
}

describe("runs thought graph routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dbList.mockImplementation(async (table: string) => table === "runs" ? [run] : []);
		dbUpdate.mockResolvedValue(run);
		getCachedThoughtGraph.mockResolvedValue({ graph, stale: false, sourceEventHash: graph.sourceEventHash, sourceEventSeqRange: graph.sourceEventSeqRange });
		generateThoughtGraph.mockResolvedValue(graph);
	});

	it("returns cached graph", async () => {
		const response = await app().request(`/api/runs/${run.id}/thought-graph`);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ runId: run.id, sourceEventHash: graph.sourceEventHash });
	});

	it("returns stale 404 when cache missing or invalid", async () => {
		getCachedThoughtGraph.mockResolvedValue({ graph, stale: true, sourceEventHash: "sha256:new", sourceEventSeqRange: [1, 2] });
		const response = await app().request(`/api/runs/${run.id}/thought-graph`);

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ stale: true, sourceEventHash: "sha256:new" });
	});

	it("validates missing runs", async () => {
		dbList.mockImplementation(async (table: string) => table === "runs" ? [] : []);
		const response = await app().request(`/api/runs/${run.id}/thought-graph`);

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: "missing run" });
	});

	it("generates graph via POST and maps missing run errors", async () => {
		let response = await app().request(`/api/runs/${run.id}/thought-graph`, { method: "POST" });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ runId: run.id });

		generateThoughtGraph.mockRejectedValue(new Error("missing run"));
		response = await app().request(`/api/runs/${run.id}/thought-graph`, { method: "POST" });
		expect(response.status).toBe(404);
	});


	it("rejects cancelling read-only delegated runs", async () => {
		dbList.mockImplementation(async (table: string) => table === "runs" ? [{ ...run, readOnly: true, origin: "delegate_agent", affectsTaskStatus: false, status: "running" }] : []);

		const response = await app().request(`/api/runs/${run.id}/cancel`, { method: "POST" });

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: "run is read-only" });
		expect(dbUpdate).not.toHaveBeenCalled();
	});

	it("rejects deleting read-only delegated runs", async () => {
		dbList.mockImplementation(async (table: string) => table === "runs" ? [{ ...run, readOnly: true, origin: "delegate_agent", affectsTaskStatus: false }] : []);

		const response = await app().request(`/api/runs/${run.id}`, { method: "DELETE" });

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: "run is read-only" });
		expect(dbUpdate).not.toHaveBeenCalled();
	});
});
