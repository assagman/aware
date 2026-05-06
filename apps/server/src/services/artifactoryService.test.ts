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
	buildUpstreamArtifactContext,
	collectUpstreamRunIds,
	ensureSessionReportForTurn,
	saveSessionReport,
} = await import("./artifactoryService");

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

function run(input: Partial<AgentRun> & Pick<AgentRun, "id" | "startedAt">): AgentRun {
	return {
		taskId: task.id,
		worktreeId: "worktree-1",
		status: "done",
		sessionId: `session-${input.id}`,
		...input,
	};
}

function artifact(input: Pick<RunArtifact, "runId" | "turnSeq" | "title" | "body"> & Partial<RunArtifact>): RunArtifact {
	return {
		id: `session-report:${input.runId}:${input.turnSeq}`,
		projectId: task.projectId,
		taskId: task.id,
		worktreeId: "worktree-1",
		kind: "session_report",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...input,
	};
}

describe("artifactory service", () => {
	beforeEach(() => {
		rows.tasks = [task];
		rows.runs = [];
		rows.runArtifacts = [];
		rows.runEvents = [];
	});

	it("saves session reports idempotently per run turn", async () => {
		const current = run({ id: "run-1", startedAt: "2026-01-01T00:00:01.000Z" });
		rows.runs = [current];

		await saveSessionReport({ run: current, task, turnSeq: 1, title: "First", body: "one" });
		await saveSessionReport({ run: current, task, turnSeq: 1, title: "First updated", body: "two" });

		expect(rows.runArtifacts).toHaveLength(1);
		expect(rows.runArtifacts[0]?.title).toBe("First updated");
		expect(rows.runArtifacts[0]?.body).toBe("two");
	});

	it("collects task parents for gate runs and task plus gate reports for ship runs", async () => {
		const taskRoot = run({ id: "task-root", lane: "task", startedAt: "2026-01-01T00:00:01.000Z" });
		const taskChild = run({ id: "task-child", lane: "task", parentRunId: taskRoot.id, startedAt: "2026-01-01T00:00:02.000Z" });
		const gate = run({ id: "gate", lane: "gate", startedAt: "2026-01-01T00:00:03.000Z" });
		const ship = run({ id: "ship", lane: "ship", startedAt: "2026-01-01T00:00:04.000Z" });
		rows.runs = [taskRoot, taskChild, gate, ship];
		rows.runArtifacts = [
			artifact({ runId: taskRoot.id, turnSeq: 1, title: "root", body: "root body", lane: "task" }),
			artifact({ runId: taskChild.id, turnSeq: 1, title: "child", body: "child body", lane: "task" }),
			artifact({ runId: gate.id, turnSeq: 1, title: "gate", body: "gate body", lane: "gate" }),
		];

		expect(await collectUpstreamRunIds(gate)).toEqual([taskRoot.id, taskChild.id]);
		const context = await buildUpstreamArtifactContext(ship);
		expect(context).toContain("root body");
		expect(context).toContain("child body");
		expect(context).toContain("gate body");
	});

	it("creates fallback report on turn end when agent report missing", async () => {
		const current = run({ id: "run-1", startedAt: "2026-01-01T00:00:01.000Z" });
		rows.runs = [current];
		rows.runEvents = [
			{ id: "event-1", runId: current.id, seq: 1, type: "user_message", payload: { text: "do work" }, createdAt: "2026-01-01T00:00:01.000Z" },
		];

		const saved = await ensureSessionReportForTurn({ run: current, task, turnSeq: 1 });

		expect(saved.title).toBe("Turn 1 auto report");
		expect(saved.body).toContain("fallback session report");
		expect(saved.body).toContain("do work");
	});

	it("adds final assistant message to agent-authored turn reports", async () => {
		const current = run({ id: "run-1", startedAt: "2026-01-01T00:00:01.000Z" });
		rows.runs = [current];
		rows.runArtifacts = [
			artifact({ runId: current.id, turnSeq: 1, title: "Agent report", body: "Actions before final answer", lane: "task", metadata: { source: "agent" } }),
		];
		rows.runEvents = [
			{ id: "event-1", runId: current.id, seq: 1, type: "user_message", payload: { text: "do work" }, createdAt: "2026-01-01T00:00:01.000Z" },
			{ id: "event-2", runId: current.id, seq: 2, type: "tool_start", payload: { toolName: "artifactory_save_session_report" }, createdAt: "2026-01-01T00:00:02.000Z" },
			{ id: "event-3", runId: current.id, seq: 3, type: "tool_end", payload: { toolName: "artifactory_save_session_report" }, createdAt: "2026-01-01T00:00:03.000Z" },
			{ id: "event-4", runId: current.id, seq: 4, type: "message_delta_batch", payload: { text: "Done. Final answer with details." }, createdAt: "2026-01-01T00:00:04.000Z" },
			{ id: "event-5", runId: current.id, seq: 5, type: "turn_end", payload: {}, createdAt: "2026-01-01T00:00:05.000Z" },
		];

		const saved = await ensureSessionReportForTurn({ run: current, task, turnSeq: 1 });

		expect(saved.body).toContain("Actions before final answer");
		expect(saved.body).toContain("## Final assistant message");
		expect(saved.body).toContain("Done. Final answer with details.");
	});
});
