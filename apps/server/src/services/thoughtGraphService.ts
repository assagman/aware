import { createHash } from "node:crypto";
import { thoughtGraphSchema, type AgentRun, type RunArtifact, type RunEvent, type Task, type ThoughtGraph, type ThoughtGraphEdgeKind, type ThoughtGraphNodeKind } from "@aware/shared";
import { db } from "../db/client";
import { runEventHub } from "./agentRuntime/runEventHub";

const MAX_DETAIL_CHARS = 360;
const MAX_TIMELINE_ITEMS = 80;
const SECRET_RE = /\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s,;]+/gi;

type NodeDraft = ThoughtGraph["nodes"][number];
type EdgeDraft = ThoughtGraph["edges"][number];

function now() {
	return new Date().toISOString();
}

function truncate(value: string, max = MAX_DETAIL_CHARS) {
	const text = redact(value).replace(/\s+/g, " ").trim();
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function redact(value: string) {
	return value.replace(SECRET_RE, (match) => `${match.split(/[:=]/)[0]}=[redacted]`);
}

function payloadRecord(payload: unknown): Record<string, unknown> {
	return payload && typeof payload === "object" && !Array.isArray(payload)
		? payload as Record<string, unknown>
		: {};
}

function textOf(payload: unknown): string {
	if (typeof payload === "string") return payload;
	const p = payloadRecord(payload);
	for (const key of ["text", "message", "delta", "thinking", "reasoning", "content", "stdout", "stderr", "output", "result"]) {
		const value = p[key];
		if (typeof value === "string") return value;
	}
	const content = p.content;
	if (Array.isArray(content))
		return content.map((item) => textOf(item)).filter(Boolean).join("\n");
	if (content && typeof content === "object") return textOf(content);
	return "";
}

function toolName(payload: unknown) {
	const p = payloadRecord(payload);
	const tool = p.tool;
	const nested = tool && typeof tool === "object" && !Array.isArray(tool)
		? (tool as Record<string, unknown>).name
		: undefined;
	return String(p.toolName ?? p.name ?? nested ?? p.tool ?? "tool");
}

function toolArgs(payload: unknown) {
	const p = payloadRecord(payload);
	return p.args ?? p.arguments ?? p.input ?? p.params ?? p.parameters ?? {};
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

function phaseFor(kind: ThoughtGraphNodeKind) {
	return {
		intent: "User intent",
		assumption: "Initial framing",
		hypothesis: "Exploration",
		evidence: "Evidence/tool feedback",
		decision: "Decisions",
		pivot: "Pivots",
		risk: "Risks",
		action: "Evidence/tool feedback",
		outcome: "Final approach",
		follow_up: "Open questions/follow-ups",
	}[kind];
}

function labelFor(kind: ThoughtGraphNodeKind) {
	return kind.replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase());
}

function hasKeyword(text: string, words: string[]) {
	const normalized = text.toLowerCase();
	return words.some((word) => normalized.includes(word));
}

function eventTurn(events: RunEvent[], event: RunEvent) {
	let turn = 1;
	for (const candidate of events) {
		if (candidate.seq >= event.seq) break;
		if (candidate.type === "turn_end") turn += 1;
	}
	return turn;
}

function addNode(nodes: NodeDraft[], input: Omit<NodeDraft, "phase" | "sourceEventIds"> & { sourceEventIds?: string[] }) {
	if (nodes.some((node) => node.id === input.id)) return input.id;
	nodes.push({ ...input, phase: phaseFor(input.kind), sourceEventIds: input.sourceEventIds ?? [] });
	return input.id;
}

function addEdge(edges: EdgeDraft[], source: string | undefined, target: string | undefined, kind: ThoughtGraphEdgeKind, label?: string) {
	if (!source || !target || source === target) return;
	const id = `e-${source}-${target}-${kind}`.replace(/[^a-zA-Z0-9:_-]/g, "-");
	if (edges.some((edge) => edge.id === id)) return;
	edges.push({ id, source, target, kind, ...(label ? { label } : {}) });
}

function semanticKind(event: RunEvent, text: string): ThoughtGraphNodeKind | undefined {
	if (event.type === "user_message" || event.type === "prompt") return "intent";
	if (event.type === "tool_start") return "action";
	if (event.type === "tool_end" || event.type === "artifact_saved") return "evidence";
	if (event.type === "error") return "risk";
	if (event.type === "result") return "outcome";
	if (hasKeyword(text, ["pivot", "changed direction", "instead", "switch", "different approach", "revised"])) return "pivot";
	if (hasKeyword(text, ["risk", "blocker", "uncertain", "concern", "could fail", "warning", "unsafe"])) return "risk";
	if (hasKeyword(text, ["decision", "decided", "choose", "selected", "will ", "plan:", "approach"])) return "decision";
	if (hasKeyword(text, ["assume", "assuming", "probably", "likely"])) return "assumption";
	if (hasKeyword(text, ["hypothesis", "maybe", "candidate", "option", "alternative"])) return "hypothesis";
	if (event.type.includes("message") || event.type.includes("text")) return "outcome";
	return undefined;
}

function summarizeTool(event: RunEvent) {
	const name = toolName(event.payload);
	const args = toolArgs(event.payload);
	const text = typeof args === "string" ? args : JSON.stringify(args);
	return `${name}${text && text !== "{}" ? ` — ${truncate(text, 160)}` : ""}`;
}

function buildTimeline(events: RunEvent[]) {
	return events
		.filter((event) => !["turn_start", "turn_end", "idle", "model"].includes(event.type))
		.slice(0, MAX_TIMELINE_ITEMS)
		.map((event) => {
			const isTool = event.type === "tool_start" || event.type === "tool_end";
			const text = isTool ? summarizeTool(event) : truncate(textOf(event.payload) || event.type, 220);
			return {
				seq: event.seq,
				type: event.type,
				title: isTool ? `${event.type.replace("_", " ")}: ${toolName(event.payload)}` : event.type.replace(/_/g, " "),
				detail: text,
				eventId: event.id,
				createdAt: event.createdAt,
			};
		});
}

function addFallback(nodes: NodeDraft[], kind: ThoughtGraphNodeKind, label: string, detail: string, seq: number, source?: string) {
	if (nodes.some((node) => node.kind === kind)) return;
	addNode(nodes, {
		id: `${kind}:fallback`,
		kind,
		label,
		detail,
		seq,
		confidence: 0.35,
		...(source ? { sourceEventIds: [source] } : {}),
	});
}

export function buildDeterministicThoughtGraph(input: {
	run: AgentRun;
	events: RunEvent[];
	artifacts: RunArtifact[];
}): ThoughtGraph {
	const events = thoughtGraphSourceEvents(input.events).sort((a, b) => a.seq - b.seq);
	const sourceEventHash = thoughtGraphSourceHash(events);
	const nodes: NodeDraft[] = [];
	const edges: EdgeDraft[] = [];
	let previousNode: string | undefined;
	let latestEvidence: string | undefined;
	let latestDecision: string | undefined;
	let latestRisk: string | undefined;

	for (const event of events) {
		const rawText = textOf(event.payload);
		const text = event.type === "tool_start" || event.type === "tool_end" ? summarizeTool(event) : rawText;
		const kind = semanticKind(event, text);
		if (!kind || (!text && event.type !== "tool_start" && event.type !== "tool_end")) continue;
		if (nodes.filter((node) => node.kind === kind).length >= 12) continue;
		const id = `${kind}:${event.seq}`;
		addNode(nodes, {
			id,
			kind,
			label: kind === "action" || kind === "evidence" ? toolName(event.payload) : labelFor(kind),
			detail: truncate(text || event.type),
			seq: event.seq,
			turn: eventTurn(events, event),
			confidence: kind === "intent" ? 0.95 : 0.7,
			...(kind === "action" || kind === "evidence" ? { toolName: toolName(event.payload) } : {}),
			sourceEventIds: [event.id],
		});
		addEdge(edges, previousNode, id, kind === "pivot" ? "changed_mind" : "led_to");
		if (kind === "evidence") latestEvidence = id;
		if (kind === "decision") {
			addEdge(edges, latestEvidence, id, "supported_by");
			latestDecision = id;
		}
		if (kind === "action") addEdge(edges, latestDecision, id, "caused_action");
		if (kind === "pivot") addEdge(edges, latestDecision, id, "changed_mind");
		if (kind === "risk") latestRisk = id;
		if (kind === "outcome") {
			addEdge(edges, latestDecision, id, "led_to");
			addEdge(edges, latestEvidence, id, "supported_by");
		}
		previousNode = id;
	}

	for (const artifact of input.artifacts.filter((artifact) => artifact.kind !== "thought_graph").slice(-8)) {
		const id = `evidence:artifact:${artifact.id}`;
		addNode(nodes, {
			id,
			kind: "evidence",
			label: artifact.title || "Run artifact",
			detail: truncate(artifact.body, 260),
			seq: 0,
			confidence: 0.8,
			sourceEventIds: [],
		});
		addEdge(edges, latestDecision, id, "supported_by");
		latestEvidence = id;
	}

	const firstEvent = events[0];
	const lastEvent = events.at(-1);
	addFallback(nodes, "intent", "Run intent", "No explicit user intent captured; graph built from available events/artifacts.", firstEvent?.seq ?? 0, firstEvent?.id);
	addFallback(nodes, "decision", "Inferred direction", "No explicit decision language found; direction inferred from tool/actions timeline.", firstEvent?.seq ?? 0, firstEvent?.id);
	addFallback(nodes, "pivot", "No clear pivot", "No explicit pivot captured; review evidence path for implicit direction changes.", lastEvent?.seq ?? 0, lastEvent?.id);
	addFallback(nodes, "risk", "Review risk", "No explicit risk captured; verify claims against tool/test evidence before reuse.", lastEvent?.seq ?? 0, lastEvent?.id);
	addFallback(nodes, "evidence", "Available evidence", input.artifacts.length ? "Run artifacts provide supporting evidence." : "No tool evidence captured; graph relies on messages/thinking only.", lastEvent?.seq ?? 0, lastEvent?.id);
	addFallback(nodes, "outcome", "Final direction", "Final approach synthesized from latest available run activity.", lastEvent?.seq ?? 0, lastEvent?.id);

	const ordered = [...nodes].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
	for (let index = 1; index < ordered.length; index += 1)
		addEdge(edges, ordered[index - 1]?.id, ordered[index]?.id, "led_to");
	const followUpId = "follow_up:next-agent";
	addNode(nodes, {
		id: followUpId,
		kind: "follow_up",
		label: "What next agent should know",
		detail: "Start from highlighted decisions, verify risks against evidence, then continue from final direction.",
		seq: lastEvent?.seq ?? 0,
		confidence: 0.75,
		sourceEventIds: lastEvent ? [lastEvent.id] : [],
	});
	addEdge(edges, latestRisk, followUpId, "left_open");

	const risks = nodes.filter((node) => node.kind === "risk").map((node) => node.detail);
	const openQuestions = nodes.filter((node) => node.kind === "follow_up").map((node) => node.detail);
	const summary = truncate([
		`Thought graph for run ${input.run.id}.`,
		`${nodes.filter((node) => node.kind === "decision").length} decision node(s), ${nodes.filter((node) => node.kind === "pivot").length} pivot node(s), ${nodes.filter((node) => node.kind === "evidence").length} evidence node(s).`,
		"Synthesized from run-local events/artifacts; raw thinking is summarized, not dumped.",
	].join(" "), 800);

	return thoughtGraphSchema.parse({
		version: 1,
		runId: input.run.id,
		sourceEventSeqRange: seqRange(events),
		sourceEventHash,
		summary,
		nodes,
		edges,
		timeline: buildTimeline(events),
		insights: [
			{ kind: "summary", text: summary, nodeIds: nodes.slice(0, 6).map((node) => node.id) },
			{ kind: "next_agent", text: "Use final direction plus unresolved risks as handoff context.", nodeIds: [followUpId] },
		],
		risks,
		openQuestions,
		generatedAt: now(),
	});
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

export async function saveThoughtGraphArtifact(runId: string, graphInput: ThoughtGraph, source = "deterministic") {
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

export async function generateThoughtGraph(runId: string) {
	const run = await loadRun(runId);
	if (!run) throw new Error("missing run");
	const { events } = await currentThoughtGraphSource(runId);
	const artifacts = (await db.list<RunArtifact>("runArtifacts")).filter((artifact) => artifact.runId === runId);
	const graph = buildDeterministicThoughtGraph({ run, events, artifacts });
	await saveThoughtGraphArtifact(runId, graph, "deterministic");
	return graph;
}
