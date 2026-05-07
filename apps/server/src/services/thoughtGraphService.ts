import { createHash } from "node:crypto";
import { thoughtGraphSchema, type AgentRun, type RunArtifact, type RunEvent, type Task, type ThoughtGraph } from "@aware/shared";
import { db } from "../db/client";
import { runEventHub } from "./agentRuntime/runEventHub";

function now() {
	return new Date().toISOString();
}

function payloadRecord(payload: unknown): Record<string, unknown> {
	return payload && typeof payload === "object" && !Array.isArray(payload)
		? payload as Record<string, unknown>
		: {};
}

export function isThoughtGraphArtifactEvent(event: RunEvent) {
	if (event.type !== "artifact_saved") return false;
	const payload = payloadRecord(event.payload);
	return payload.kind === "thought_graph" || String(payload.artifactId ?? "").startsWith("thought-graph:");
}

export function thoughtGraphSourceEvents(events: RunEvent[]) {
	return events.filter((event) => !isThoughtGraphArtifactEvent(event));
}

function sourceEvents(events: RunEvent[]) {
	return thoughtGraphSourceEvents(events)
		.sort((a, b) => a.seq - b.seq)
		.map((event) => ({ id: event.id, seq: event.seq, type: event.type, payload: event.payload, createdAt: event.createdAt }));
}

export function thoughtGraphSourceHash(events: RunEvent[]) {
	const hash = createHash("sha256").update(JSON.stringify(sourceEvents(events))).digest("hex");
	return `sha256:${hash}`;
}

function seqRange(events: RunEvent[]): [number, number] {
	if (!events.length) return [0, 0];
	const seqs = events.map((event) => event.seq);
	return [Math.min(...seqs), Math.max(...seqs)];
}

function artifactId(runId: string) {
	return `thought-graph:${runId}`;
}

async function loadRun(runId: string) {
	return (await db.list<AgentRun>("runs")).find((run) => run.id === runId);
}

async function loadTask(run: AgentRun) {
	return (await db.list<Task>("tasks")).find((task) => task.id === run.taskId);
}

export async function currentThoughtGraphSource(runId: string) {
	await runEventHub.flush(runId);
	const events = thoughtGraphSourceEvents(await runEventHub.persistedEvents(runId));
	return { events, sourceEventHash: thoughtGraphSourceHash(events), sourceEventSeqRange: seqRange(events) };
}

export async function currentThoughtGraphAnalyzerInput(runId: string) {
	await runEventHub.flush(runId);
	const events = thoughtGraphSourceEvents(await runEventHub.persistedEvents(runId)).sort((a, b) => a.seq - b.seq);
	const artifacts = (await db.list<RunArtifact>("runArtifacts"))
		.filter((artifact) => artifact.runId === runId && artifact.kind !== "thought_graph")
		.sort((a, b) => a.turnSeq - b.turnSeq || a.createdAt.localeCompare(b.createdAt));
	return {
		version: 1,
		runId,
		sourceEventHash: thoughtGraphSourceHash(events),
		sourceEventSeqRange: seqRange(events),
		events,
		artifacts,
		visibilityContract: [
			"You may inspect every event, tool call, tool result, message, thinking delta, turn marker, and non-ThoughtGraph artifact.",
			"The saved ThoughtGraph is user-visible: distill insights, decisions, pivots, risks, outcomes, and meaningful connections.",
			"Do not dump raw tool payloads, Turn/session-report boilerplate, or low-value runtime metadata as graph nodes unless it directly explains the reasoning.",
		],
	};
}

export async function getCachedThoughtGraph(runId: string) {
	const { sourceEventHash, sourceEventSeqRange } = await currentThoughtGraphSource(runId);
	const artifact = (await db.list<RunArtifact>("runArtifacts")).find((row) => row.id === artifactId(runId));
	if (!artifact) return { graph: undefined, artifact: undefined, stale: true, sourceEventHash, sourceEventSeqRange };
	try {
		const graph = thoughtGraphSchema.parse(JSON.parse(artifact.body));
		const stale = graph.sourceEventHash !== sourceEventHash || graph.sourceEventSeqRange[1] !== sourceEventSeqRange[1];
		return { graph, artifact, stale, sourceEventHash, sourceEventSeqRange };
	} catch {
		return { graph: undefined, artifact, stale: true, sourceEventHash, sourceEventSeqRange };
	}
}

export async function saveThoughtGraphArtifact(runId: string, graphInput: ThoughtGraph, source = "thought-agent") {
	const run = await loadRun(runId);
	if (!run) throw new Error("missing run");
	const task = await loadTask(run);
	if (!task) throw new Error("missing task");
	const graph = thoughtGraphSchema.parse({ ...graphInput, runId });
	const artifacts = (await db.list<RunArtifact>("runArtifacts")).filter((artifact) => artifact.runId === runId);
	const timestamp = now();
	const existing = artifacts.find((artifact) => artifact.id === artifactId(runId));
	const artifact: RunArtifact = {
		id: artifactId(runId),
		projectId: task.projectId,
		taskId: task.id,
		runId,
		worktreeId: run.worktreeId,
		kind: "thought_graph",
		turnSeq: 1,
		lane: run.lane ?? "task",
		...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
		title: "Thought graph",
		body: JSON.stringify(graph, null, 2),
		metadata: {
			source,
			sourceEventHash: graph.sourceEventHash,
			sourceEventSeqRange: graph.sourceEventSeqRange,
		},
		createdAt: existing?.createdAt ?? timestamp,
		updatedAt: timestamp,
	};
	await db.insert("runArtifacts", artifact);
	await runEventHub.emit(runId, "artifact_saved", { artifactId: artifact.id, kind: artifact.kind, title: artifact.title }, { immediate: true });
	return artifact;
}

function thoughtAgentRequest(targetRunId: string) {
	return [
		`Analyze target run ${targetRunId} and save exactly one ThoughtGraph JSON artifact.`,
		"Use thought_fetch_run_events first. It returns all run-local events including tool calls/results, thinking deltas, messages, turn markers, and non-ThoughtGraph artifacts.",
		"Use thought_fetch_artifacts if artifact bodies need deeper inspection.",
		"Your analysis must be pure LLM synthesis. Do not rely on deterministic node extraction.",
		"The graph is user-visible: show distilled insights, decisions, pivots, risks, outcomes, and concrete valuable actions with clear connections.",
		"Raw tool calls, Turn/session-report boilerplate, artifact_saved bookkeeping, model/idle events, and verbose payloads are private context only; include them only when they explain an insight.",
		"Keep graph dense and readable: short labels, concise details, meaningful edge labels/kinds, and useful helper timeline/insights.",
		"Use sourceEventHash and sourceEventSeqRange exactly as returned by thought_fetch_run_events.",
		"Call thought_save_graph with strict ThoughtGraph JSON when ready.",
	].join("\n");
}

export async function generateThoughtGraph(runId: string) {
	const run = await loadRun(runId);
	if (!run) throw new Error("missing run");
	const task = await loadTask(run);
	if (!task) throw new Error("missing task");
	const [{ listThoughtAgentsForRun }, { assertAllowedWorktree }, { flueRuntime }] = await Promise.all([
		import("./thoughtAgentService"),
		import("./projectService"),
		import("./agentRuntime/flueRuntime"),
	]);
	const agents = await listThoughtAgentsForRun();
	if (!agents.length) throw new Error("ThoughtAgent unavailable");
	const worktree = await assertAllowedWorktree(run.worktreeId);
	await flueRuntime.startRun({
		task,
		worktreeId: run.worktreeId,
		worktreePath: worktree.path,
		agents,
		message: thoughtAgentRequest(run.id),
		lane: "graph",
		parentRunId: run.id,
		affectsTaskStatus: false,
		completedStatus: "done",
		thoughtTargetRunId: run.id,
		waitForCompletion: true,
		suppressUpstreamArtifacts: true,
	});
	const cached = await getCachedThoughtGraph(run.id);
	if (!cached.graph) throw new Error("ThoughtAgent did not save thought graph");
	if (cached.stale) throw new Error("ThoughtAgent saved stale thought graph");
	return cached.graph;
}
