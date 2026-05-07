import { createHash } from "node:crypto";
import { thoughtGraphSchema, type AgentRun, type RunArtifact, type RunEvent, type Task, type ThoughtGraph, type ThoughtGraphEdgeKind, type ThoughtGraphNodeKind } from "@aware/shared";
import { db } from "../db/client";
import { runEventHub } from "./agentRuntime/runEventHub";

const MAX_DETAIL_CHARS = 260;
const MAX_TIMELINE_ITEMS = 36;
const MAX_ACTION_NODES = 6;
const MAX_SEGMENT_NODES_PER_KIND = 8;
const SECRET_RE = /\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s,;]+/gi;
const OMITTED_TIMELINE_EVENT_TYPES = new Set(["turn_start", "turn_end", "idle", "model", "artifact_saved"]);
const TOOL_EVENT_TYPES = new Set(["tool_start", "tool_end"]);

type NodeDraft = ThoughtGraph["nodes"][number];
type EdgeDraft = ThoughtGraph["edges"][number];
type AnalyzerAction = {
	seq: number;
	eventId: string;
	toolName: string;
	label: string;
	detail: string;
};

type AnalyzerInput = {
	sourceEventHash: string;
	sourceEventSeqRange: [number, number];
	thoughts: ThoughtGraph["timeline"];
	concreteActions: AnalyzerAction[];
	omitted: {
		turnEvents: number;
		rawToolEvents: number;
		sessionArtifacts: number;
		thoughtGraphArtifacts: number;
	};
};

function now() {
	return new Date().toISOString();
}

function redact(value: string) {
	return value.replace(SECRET_RE, (match) => `${match.split(/[:=]/)[0]}=[redacted]`);
}

function truncate(value: string, max = MAX_DETAIL_CHARS) {
	const text = redact(value).replace(/\s+/g, " ").trim();
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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

function isIgnoredArtifactEvent(event: RunEvent) {
	if (event.type !== "artifact_saved") return false;
	const payload = payloadRecord(event.payload);
	const id = String(payload.artifactId ?? "");
	return isThoughtGraphArtifactEvent(event) || payload.kind === "session_report" || id.startsWith("session-report:");
}

export function thoughtGraphSourceEvents(events: RunEvent[]) {
	return events.filter((event) => !isIgnoredArtifactEvent(event));
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

function addNode(nodes: NodeDraft[], input: Omit<NodeDraft, "phase" | "sourceEventIds"> & { sourceEventIds?: string[] }) {
	if (nodes.some((node) => node.id === input.id)) return input.id;
	nodes.push({ ...input, phase: phaseFor(input.kind), sourceEventIds: input.sourceEventIds ?? [] });
	return input.id;
}

function addEdge(edges: EdgeDraft[], source: string | undefined, target: string | undefined, kind: ThoughtGraphEdgeKind, label?: string) {
	if (!source || !target || source === target) return;
	if (edges.some((edge) => edge.source === source && edge.target === target)) return;
	const id = `e-${source}-${target}-${kind}`.replace(/[^a-zA-Z0-9:_-]/g, "-");
	if (edges.some((edge) => edge.id === id)) return;
	edges.push({ id, source, target, kind, ...(label ? { label } : {}) });
}

function stripPromptBoilerplate(text: string) {
	const withoutUpstream = text.split(/\n\s*#{1,6}\s+Upstream Artifactory\b/i)[0]
		?.split(/\n\nUpstream Artifactory:/i)[0]
		?.trim() ?? text.trim();
	for (const heading of ["## User request", "## Annotation request", "## Task", "# Task"]) {
		const index = withoutUpstream.indexOf(heading);
		if (index < 0) continue;
		const rest = withoutUpstream.slice(index + heading.length).replace(/^\s+/, "");
		const nextHeading = rest.search(/\n#{1,6}\s+/);
		return (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest).trim();
	}
	return withoutUpstream;
}

function splitSegments(text: string) {
	return text
		.replace(/([.!?])\s+/g, "$1\n")
		.split(/\n+|\s+[•·]\s+/)
		.map((segment) => segment.replace(/^\s*(?:[-*]\s*)?/, "").trim())
		.filter((segment) => segment.length >= 8);
}

function prefixedKind(segment: string): ThoughtGraphNodeKind | undefined {
	const match = segment.match(/^(decision|decided|risk|pivot|hypothesis|assumption|evidence|outcome|follow[-_ ]?up|open question|question)\s*[:：-]\s*/i);
	if (!match) return undefined;
	const key = match[1]?.toLowerCase().replace(/[\s-]/g, "_");
	if (key === "decided") return "decision";
	if (key === "open_question" || key === "question" || key === "follow_up") return "follow_up";
	if (key === "assumption") return "assumption";
	if (["decision", "risk", "pivot", "hypothesis", "evidence", "outcome"].includes(key ?? "")) return key as ThoughtGraphNodeKind;
	return undefined;
}

function semanticKind(event: RunEvent, segment: string): ThoughtGraphNodeKind | undefined {
	if (event.type === "user_message" || event.type === "prompt") return "intent";
	if (event.type === "error") return "risk";
	if (event.type === "result") return "outcome";
	const prefixed = prefixedKind(segment);
	if (prefixed) return prefixed;
	if (hasKeyword(segment, ["pivot", "changed direction", "instead", "switch", "different approach", "revised"])) return "pivot";
	if (hasKeyword(segment, ["risk", "blocker", "uncertain", "concern", "could fail", "warning", "unsafe"])) return "risk";
	if (hasKeyword(segment, ["decision", "decided", "choose", "selected", "plan:", "approach:"])) return "decision";
	if (hasKeyword(segment, ["assume", "assuming", "probably", "likely"])) return "assumption";
	if (hasKeyword(segment, ["hypothesis", "maybe", "candidate", "option", "alternative"])) return "hypothesis";
	if (hasKeyword(segment, ["evidence", "verified", "found", "confirmed", "test passed", "tests pass", "failed because"])) return "evidence";
	if (event.type.includes("message") || event.type.includes("text")) {
		if (hasKeyword(segment, ["done", "final", "fixed", "applied", "implemented", "completed", "root cause"])) return "outcome";
	}
	return undefined;
}

function segmentWithoutPrefix(segment: string) {
	return segment.replace(/^(decision|decided|risk|pivot|hypothesis|assumption|evidence|outcome|follow[-_ ]?up|open question|question)\s*[:：-]\s*/i, "").trim();
}

function labelForSegment(kind: ThoughtGraphNodeKind, segment: string) {
	const body = segmentWithoutPrefix(segment);
	if (!body) return labelFor(kind);
	return truncate(body, 72);
}

function collectPaths(value: unknown, key = "", paths = new Set<string>()) {
	const normalizedKey = key.toLowerCase();
	const isPathKey = ["path", "filepath", "file", "filename", "targetpath"].includes(normalizedKey);
	const isPathArrayKey = ["paths", "files", "filepaths"].includes(normalizedKey);
	if (typeof value === "string") {
		if (isPathKey || isPathArrayKey) paths.add(value);
		return paths;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectPaths(item, key, paths);
		return paths;
	}
	if (!value || typeof value !== "object") return paths;
	for (const [childKey, childValue] of Object.entries(value)) collectPaths(childValue, childKey, paths);
	return paths;
}

function commandOf(value: unknown): string {
	const record = payloadRecord(value);
	for (const key of ["command", "cmd", "script", "code", "query"]) {
		const item = record[key];
		if (typeof item === "string") return item;
	}
	return "";
}

function commandActionLabel(command: string) {
	const lower = command.toLowerCase();
	if (/\b(?:test|vitest|jest|playwright|typecheck|lint|build)\b/.test(lower)) return "Verified behavior";
	if (/\b(?:rg|grep|fd|find|sg)\b/.test(lower)) return "Searched code";
	if (/\bgit\s+(?:status|diff|log|show)\b/.test(lower)) return "Checked repo state";
	return "Ran command";
}

function concreteToolAction(event: RunEvent): AnalyzerAction | undefined {
	if (event.type !== "tool_start") return undefined;
	const name = toolName(event.payload);
	const args = toolArgs(event.payload);
	const normalized = name.toLowerCase().split(/[.:/]/).at(-1) ?? name.toLowerCase();
	const paths = [...collectPaths(args)].slice(0, 3);
	const command = commandOf(args);
	if (normalized.startsWith("read") && paths.length) {
		return { seq: event.seq, eventId: event.id, toolName: name, label: "Read file", detail: truncate(paths.join(", "), 180) };
	}
	if ((normalized.startsWith("edit") || normalized.startsWith("write")) && paths.length) {
		return { seq: event.seq, eventId: event.id, toolName: name, label: "Changed file", detail: truncate(paths.join(", "), 180) };
	}
	if (command) {
		return { seq: event.seq, eventId: event.id, toolName: name, label: commandActionLabel(command), detail: truncate(command, 180) };
	}
	if (paths.length) {
		return { seq: event.seq, eventId: event.id, toolName: name, label: "Used file tool", detail: truncate(paths.join(", "), 180) };
	}
	return undefined;
}

function eventThoughtNodes(event: RunEvent) {
	if (TOOL_EVENT_TYPES.has(event.type) || OMITTED_TIMELINE_EVENT_TYPES.has(event.type)) return [];
	const raw = textOf(event.payload);
	if (!raw) return [];
	const text = event.type === "user_message" || event.type === "prompt" ? stripPromptBoilerplate(raw) : raw;
	const segments = event.type === "user_message" || event.type === "prompt" ? [text] : splitSegments(text);
	return segments.flatMap((segment, index) => {
		const kind = semanticKind(event, segment);
		if (!kind) return [];
		return [{
			id: `${kind}:${event.seq}:${index}`,
			kind,
			label: labelForSegment(kind, segment),
			detail: truncate(segmentWithoutPrefix(segment) || segment),
			seq: event.seq,
			confidence: kind === "intent" ? 0.95 : event.type.includes("thinking") ? 0.82 : 0.72,
			sourceEventIds: [event.id],
		} satisfies Omit<NodeDraft, "phase" | "sourceEventIds"> & { sourceEventIds?: string[] }];
	});
}

function buildTimeline(events: RunEvent[]) {
	const items: ThoughtGraph["timeline"] = [];
	for (const event of events) {
		if (OMITTED_TIMELINE_EVENT_TYPES.has(event.type)) continue;
		const action = concreteToolAction(event);
		if (action) {
			items.push({
				seq: event.seq,
				type: "action",
				title: action.label,
				detail: action.detail,
				eventId: event.id,
				createdAt: event.createdAt,
			});
			continue;
		}
		if (TOOL_EVENT_TYPES.has(event.type)) continue;
		const rawText = textOf(event.payload);
		const text = truncate((event.type === "user_message" || event.type === "prompt" ? stripPromptBoilerplate(rawText) : rawText) || event.type, 220);
		if (!text) continue;
		items.push({
			seq: event.seq,
			type: event.type,
			title: event.type.replace(/_/g, " "),
			detail: text,
			eventId: event.id,
			createdAt: event.createdAt,
		});
	}
	return items.slice(0, MAX_TIMELINE_ITEMS);
}

function addChronologyAndSemanticEdges(nodes: NodeDraft[], edges: EdgeDraft[]) {
	const orderById = new Map(nodes.map((node, index) => [node.id, index]));
	const ordered = [...nodes].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0));
	let latestEvidenceOrAction: string | undefined;
	let latestDecision: string | undefined;
	let latestHypothesis: string | undefined;
	let latestRisk: string | undefined;
	for (let index = 0; index < ordered.length; index += 1) {
		const node = ordered[index];
		if (!node) continue;
		const previous = ordered[index - 1];
		if (node.kind === "hypothesis" || node.kind === "assumption") latestHypothesis = node.id;
		if (node.kind === "evidence" || node.kind === "action") latestEvidenceOrAction = node.id;
		if (node.kind === "decision") {
			addEdge(edges, latestHypothesis, node.id, "supported_by");
			addEdge(edges, latestEvidenceOrAction, node.id, "supported_by");
			latestDecision = node.id;
		}
		if (node.kind === "action") addEdge(edges, latestDecision, node.id, "caused_action");
		if (node.kind === "pivot") addEdge(edges, latestDecision, node.id, "changed_mind");
		if (node.kind === "risk") {
			addEdge(edges, latestDecision, node.id, "left_open");
			latestRisk = node.id;
		}
		if (node.kind === "follow_up") addEdge(edges, latestRisk ?? latestDecision, node.id, "left_open");
		if (node.kind === "outcome") {
			addEdge(edges, latestDecision, node.id, "led_to");
			addEdge(edges, latestEvidenceOrAction, node.id, "supported_by");
		}
		addEdge(edges, previous?.id, node.id, node.kind === "pivot" ? "changed_mind" : "led_to");
	}
}

function addFallbackIntent(nodes: NodeDraft[], events: RunEvent[]) {
	if (nodes.length || !events.length) return;
	const firstEvent = events[0];
	if (!firstEvent) return;
	addNode(nodes, {
		id: "intent:fallback",
		kind: "intent",
		label: "No thinking captured",
		detail: "Run has activity, but no reasoning text was captured for a focused graph.",
		seq: firstEvent.seq,
		confidence: 0.35,
		sourceEventIds: [firstEvent.id],
	});
}

export function buildThoughtGraphAnalyzerInput(input: { events: RunEvent[]; artifacts: RunArtifact[] }): AnalyzerInput {
	const events = thoughtGraphSourceEvents(input.events).sort((a, b) => a.seq - b.seq);
	const concreteActions = events.map(concreteToolAction).filter((action): action is AnalyzerAction => Boolean(action)).slice(0, MAX_ACTION_NODES);
	return {
		sourceEventHash: thoughtGraphSourceHash(events),
		sourceEventSeqRange: seqRange(events),
		thoughts: buildTimeline(events),
		concreteActions,
		omitted: {
			turnEvents: input.events.filter((event) => event.type === "turn_start" || event.type === "turn_end").length,
			rawToolEvents: events.filter((event) => TOOL_EVENT_TYPES.has(event.type)).length,
			sessionArtifacts: input.artifacts.filter((artifact) => artifact.kind === "session_report").length,
			thoughtGraphArtifacts: input.artifacts.filter((artifact) => artifact.kind === "thought_graph").length,
		},
	};
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
	const counts = new Map<ThoughtGraphNodeKind, number>();
	const seen = new Set<string>();

	for (const event of events) {
		const action = concreteToolAction(event);
		const drafts = action
			? [{
				id: `action:${event.seq}`,
				kind: "action" as const,
				label: action.label,
				detail: action.detail,
				seq: event.seq,
				confidence: 0.76,
				toolName: action.toolName,
				sourceEventIds: [event.id],
			}]
			: eventThoughtNodes(event);
		for (const draft of drafts) {
			const count = counts.get(draft.kind) ?? 0;
			if (count >= (draft.kind === "action" ? MAX_ACTION_NODES : MAX_SEGMENT_NODES_PER_KIND)) continue;
			const key = `${draft.kind}:${draft.detail.toLowerCase()}`;
			if (seen.has(key)) continue;
			seen.add(key);
			counts.set(draft.kind, count + 1);
			addNode(nodes, draft);
		}
	}

	addFallbackIntent(nodes, events);
	addChronologyAndSemanticEdges(nodes, edges);

	const risks = nodes.filter((node) => node.kind === "risk").map((node) => node.detail);
	const openQuestions = nodes.filter((node) => node.kind === "follow_up").map((node) => node.detail);
	const summary = truncate([
		`distilled thought graph for run ${input.run.id}.`,
		`${nodes.filter((node) => node.kind === "decision").length} decision node(s), ${nodes.filter((node) => node.kind === "pivot").length} pivot node(s), ${nodes.filter((node) => node.kind === "risk").length} risk node(s), ${nodes.filter((node) => node.kind === "action").length} concrete action node(s).`,
		"Focused on run-local thinking and concrete actions; turn/session artifacts and raw tool event payloads are omitted.",
	].join(" "), 800);
	const primaryNodeIds = nodes
		.filter((node) => ["decision", "pivot", "risk", "outcome"].includes(node.kind))
		.slice(0, 8)
		.map((node) => node.id);

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
			{ kind: "summary", text: summary, nodeIds: primaryNodeIds },
			{ kind: "noise_filter", text: "Turn artifacts, session reports, raw tool_start/tool_end payloads, and Thought Graph self-events are excluded from the visualization.", nodeIds: [] },
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

export async function currentThoughtGraphAnalyzerInput(runId: string) {
	await runEventHub.flush(runId);
	const events = await runEventHub.persistedEvents(runId);
	const artifacts = (await db.list<RunArtifact>("runArtifacts")).filter((artifact) => artifact.runId === runId);
	return buildThoughtGraphAnalyzerInput({ events, artifacts });
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

function thoughtAgentRequest(targetRunId: string) {
	return [
		`Analyze target run ${targetRunId} and save a ThoughtGraph JSON artifact.`,
		"Use thought_fetch_run_events first. Use thought_fetch_artifacts only if needed.",
		"Focus on agent thinking messages, decisions, pivots, risks, outcomes, and concrete actions.",
		"Do not create nodes for Turn/session-report artifacts, artifact_saved events, raw tool_start/tool_end payloads, model events, or idle events.",
		"Keep graph dense: max 14 nodes, short labels, concise details, meaningful edges only.",
		"Use sourceEventHash and sourceEventSeqRange exactly as returned by thought_fetch_run_events.",
		"Call thought_save_graph with strict ThoughtGraph JSON when ready.",
	].join("\n");
}

async function tryGenerateThoughtGraphWithAgent(run: AgentRun, task: Task) {
	try {
		const [{ listThoughtAgentsForRun }, { assertAllowedWorktree }, { flueRuntime }] = await Promise.all([
			import("./thoughtAgentService"),
			import("./projectService"),
			import("./agentRuntime/flueRuntime"),
		]);
		const agents = await listThoughtAgentsForRun();
		if (!agents.length) return undefined;
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
		return cached.graph && !cached.stale ? cached.graph : undefined;
	} catch {
		return undefined;
	}
}

export async function generateThoughtGraph(runId: string) {
	const run = await loadRun(runId);
	if (!run) throw new Error("missing run");
	const task = await loadTask(run);
	if (!task) throw new Error("missing task");
	const agentGraph = await tryGenerateThoughtGraphWithAgent(run, task);
	if (agentGraph) return agentGraph;
	const { events } = await currentThoughtGraphSource(runId);
	const artifacts = (await db.list<RunArtifact>("runArtifacts")).filter((artifact) => artifact.runId === runId);
	const graph = buildDeterministicThoughtGraph({ run, events, artifacts });
	await saveThoughtGraphArtifact(runId, graph, "deterministic");
	return graph;
}
