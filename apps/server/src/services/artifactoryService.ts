import type { AgentRun, RunArtifact, RunEvent, RunLane, Task } from "@aware/shared";
import { db } from "../db/client";
import { runEventHub } from "./agentRuntime/runEventHub";

const now = () => new Date().toISOString();
const MAX_REPORT_BODY_CHARS = 16_000;
const MAX_FINAL_ASSISTANT_CHARS = 6_000;
const MAX_CONTEXT_CHARS = 28_000;
const MAX_CONTEXT_ARTIFACTS = 24;
const FINAL_ASSISTANT_MARKER = "## Final assistant message";
const TOOL_ACTIVITY_LINE_RE = /^\s*(?:[-*]\s*)?(?:tool\s*(?:call|start|end|result|execution)|tool_call|tool_use|function\s*call)\s*:/i;

function runLane(run: AgentRun): RunLane {
	return run.lane === "gate" || run.lane === "ship" || run.lane === "graph" ? run.lane : "task";
}

function truncate(value: string, max = MAX_REPORT_BODY_CHARS) {
	return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
}

function sessionReportId(runId: string, turnSeq: number) {
	return `session-report:${runId}:${turnSeq}`;
}

function sanitizeArtifactBodyForContext(body: string) {
	return body
		.split(/\r?\n/)
		.filter((line) => !TOOL_ACTIVITY_LINE_RE.test(line))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function payloadText(payload: unknown) {
	if (typeof payload === "string") return payload;
	if (!payload || typeof payload !== "object") return "";
	const value = payload as { text?: unknown; message?: unknown; toolName?: unknown; isError?: unknown };
	if (typeof value.text === "string") return value.text;
	if (typeof value.message === "string") return value.message;
	return "";
}

function eventSummary(event: RunEvent) {
	if (event.type === "tool_start" || event.type === "tool_end") return "";
	if (event.type === "user_message") return `user: ${truncate(payloadText(event.payload), 600)}`;
	if (event.type === "message_delta_batch" || event.type === "text_delta") return `assistant: ${truncate(payloadText(event.payload), 1000)}`;
	if (event.type === "result") return "result recorded";
	if (event.type === "error") return `error: ${truncate(payloadText(event.payload), 1000)}`;
	return "";
}

function eventsForTurn(events: RunEvent[], turnSeq: number) {
	let currentTurn = 1;
	const selected: RunEvent[] = [];
	for (const event of events.sort((a, b) => a.seq - b.seq)) {
		if (currentTurn === turnSeq) selected.push(event);
		if (event.type === "turn_end") currentTurn += 1;
	}
	return selected;
}

function assistantSegments(events: RunEvent[]) {
	const segments: string[] = [];
	let buffer = "";
	for (const event of events) {
		const isAssistant = event.type === "message_delta_batch" || event.type === "text_delta";
		const text = isAssistant ? payloadText(event.payload) : "";
		if (text) {
			buffer += text;
			continue;
		}
		if (buffer.trim()) segments.push(buffer.trim());
		buffer = "";
	}
	if (buffer.trim()) segments.push(buffer.trim());
	return segments;
}

async function finalAssistantMessageForTurn(runId: string, turnSeq: number) {
	await runEventHub.flush(runId);
	const events = eventsForTurn(await runEventHub.persistedEvents(runId), turnSeq);
	return assistantSegments(events).at(-1) ?? "";
}

function reportWithFinalAssistantMessage(body: string, message: string) {
	const trimmedMessage = message.trim();
	if (!trimmedMessage || body.includes(FINAL_ASSISTANT_MARKER)) return body;
	const finalSection = `\n\n---\n\n${FINAL_ASSISTANT_MARKER}\n${truncate(trimmedMessage, MAX_FINAL_ASSISTANT_CHARS)}`;
	const budget = Math.max(0, MAX_REPORT_BODY_CHARS - finalSection.length);
	const base = body.trim();
	const preservedBody = base.length <= budget
		? base
		: `${base.slice(0, Math.max(0, budget - 56)).trimEnd()}\n...[truncated to preserve final assistant message]`;
	return `${preservedBody}${finalSection}`;
}

function artifactSource(artifact: RunArtifact): "agent" | "fallback" {
	return artifact.metadata?.source === "fallback" ? "fallback" : "agent";
}

async function taskForRun(run: AgentRun, task?: Task) {
	if (task) return task;
	return (await db.list<Task>("tasks")).find((row) => row.id === run.taskId);
}

export async function nextSessionReportTurnSeq(runId: string) {
	const events = await db.list<RunEvent>("runEvents");
	const completedTurns = events.filter((event) => event.runId === runId && event.type === "turn_end").length;
	if (completedTurns > 0) return completedTurns + 1;
	const artifacts = await db.list<RunArtifact>("runArtifacts");
	const lastArtifactTurn = Math.max(0, ...artifacts
		.filter((artifact) => artifact.runId === runId && artifact.kind === "session_report")
		.map((artifact) => artifact.turnSeq));
	return lastArtifactTurn + 1;
}

export async function saveSessionReport(input: {
	run: AgentRun;
	task?: Task;
	turnSeq: number;
	title?: string;
	body: string;
	metadata?: Record<string, unknown>;
	source?: "agent" | "fallback";
}) {
	const task = await taskForRun(input.run, input.task);
	if (!task) throw new Error(`missing task for run ${input.run.id}`);
	const existing = (await db.list<RunArtifact>("runArtifacts")).find(
		(artifact) => artifact.id === sessionReportId(input.run.id, input.turnSeq),
	);
	const timestamp = now();
	const lane = runLane(input.run);
	const artifact: RunArtifact = {
		id: sessionReportId(input.run.id, input.turnSeq),
		projectId: task.projectId,
		taskId: input.run.taskId,
		runId: input.run.id,
		worktreeId: input.run.worktreeId,
		kind: "session_report",
		turnSeq: input.turnSeq,
		lane,
		...(input.run.parentRunId ? { parentRunId: input.run.parentRunId } : {}),
		title: input.title?.trim() || `Turn ${input.turnSeq} session report`,
		body: truncate(input.body.trim()),
		...(input.metadata ? { metadata: { ...input.metadata, source: input.source ?? "agent" } } : { metadata: { source: input.source ?? "agent" } }),
		createdAt: existing?.createdAt ?? timestamp,
		updatedAt: timestamp,
	};
	await db.insert("runArtifacts", artifact);
	await runEventHub.emit(
		input.run.id,
		"artifact_saved",
		{
			artifactId: artifact.id,
			kind: artifact.kind,
			turnSeq: artifact.turnSeq,
			title: artifact.title,
			source: artifact.metadata?.source,
		},
		{ immediate: true },
	);
	return artifact;
}

export async function latestSessionReportForRun(runId: string) {
	return (await db.list<RunArtifact>("runArtifacts"))
		.filter((artifact) => artifact.runId === runId && artifact.kind === "session_report")
		.sort((a, b) => b.turnSeq - a.turnSeq || b.updatedAt.localeCompare(a.updatedAt))[0];
}

export async function ensureSessionReportForTurn(input: {
	run: AgentRun;
	task?: Task;
	turnSeq: number;
}) {
	await runEventHub.flush(input.run.id);
	const finalAssistantMessage = await finalAssistantMessageForTurn(input.run.id, input.turnSeq);
	const existing = (await db.list<RunArtifact>("runArtifacts")).find(
		(artifact) => artifact.id === sessionReportId(input.run.id, input.turnSeq),
	);
	if (existing) {
		const body = reportWithFinalAssistantMessage(existing.body, finalAssistantMessage);
		if (body === existing.body) return existing;
		return saveSessionReport({
			run: input.run,
			...(input.task ? { task: input.task } : {}),
			turnSeq: input.turnSeq,
			title: existing.title,
			body,
			...(existing.metadata ? { metadata: existing.metadata } : {}),
			source: artifactSource(existing),
		});
	}
	const body = reportWithFinalAssistantMessage(
		await fallbackSessionReport(input.run, input.turnSeq),
		finalAssistantMessage,
	);
	return saveSessionReport({
		run: input.run,
		...(input.task ? { task: input.task } : {}),
		turnSeq: input.turnSeq,
		title: `Turn ${input.turnSeq} auto report`,
		body,
		source: "fallback",
	});
}

async function fallbackSessionReport(run: AgentRun, turnSeq: number) {
	await runEventHub.flush(run.id);
	const events = (await runEventHub.persistedEvents(run.id))
		.filter((event) => event.type !== "prompt" && event.type !== "thinking_delta_batch")
		.slice(-40)
		.map(eventSummary)
		.filter(Boolean);
	return truncate([
		`Aware generated this fallback session report because no agent-authored report was saved before turn ${turnSeq} ended.`,
		`Run: ${run.id}`,
		`Lane: ${runLane(run)}`,
		"",
		"Recent activity:",
		events.length ? events.map((line) => `- ${line}`).join("\n") : "- No persisted activity beyond turn end.",
	].join("\n"));
}

function startedBeforeOrSame(left: AgentRun, right: AgentRun) {
	return left.startedAt.localeCompare(right.startedAt) <= 0;
}

export async function collectUpstreamRunIds(run: AgentRun) {
	const runs = (await db.list<AgentRun>("runs")).filter(
		(row) => row.taskId === run.taskId && row.id !== run.id && !row.deletedAt,
	);
	const byId = new Map(runs.map((row) => [row.id, row]));
	const ordered = new Map<string, AgentRun>();
	const lane = runLane(run);
	const priorRuns = runs.filter((row) => startedBeforeOrSame(row, run));
	const addWithParents = (candidate: AgentRun | undefined) => {
		if (!candidate || ordered.has(candidate.id)) return;
		if (candidate.parentRunId) addWithParents(byId.get(candidate.parentRunId));
		ordered.set(candidate.id, candidate);
	};
	if (run.parentRunId) addWithParents(byId.get(run.parentRunId));
	if (lane === "task") return [...ordered.keys()];
	if (lane === "gate") {
		for (const candidate of priorRuns.filter((row) => runLane(row) === "task")) addWithParents(candidate);
		for (const candidate of priorRuns.filter((row) => runLane(row) === "gate" && row.parentRunId)) addWithParents(candidate);
		return [...ordered.keys()];
	}
	if (lane === "ship") {
		for (const candidate of priorRuns.filter((row) => runLane(row) !== "ship")) addWithParents(candidate);
		return [...ordered.keys()];
	}
	for (const candidate of priorRuns) addWithParents(candidate);
	return [...ordered.keys()];
}

export async function listUpstreamSessionReports(run: AgentRun) {
	const upstream = new Set(await collectUpstreamRunIds(run));
	if (!upstream.size) return [];
	return (await db.list<RunArtifact>("runArtifacts"))
		.filter((artifact) => artifact.kind === "session_report" && upstream.has(artifact.runId))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, MAX_CONTEXT_ARTIFACTS);
}

export async function buildUpstreamArtifactContext(run: AgentRun) {
	const artifacts = await listUpstreamSessionReports(run);
	if (!artifacts.length) return "(none)";
	let total = 0;
	let truncated = false;
	const sections: string[] = [];
	for (const artifact of artifacts) {
		const body = sanitizeArtifactBodyForContext(artifact.body);
		if (!body) continue;
		const header = [
			`### ${artifact.title}`,
			`run: ${artifact.runId}`,
			`lane: ${artifact.lane ?? "task"}`,
			`turn: ${artifact.turnSeq}`,
			`saved: ${artifact.updatedAt}`,
		].join(" · ");
		const section = `${header}\n${body}`;
		if (total + section.length > MAX_CONTEXT_CHARS) {
			truncated = true;
			break;
		}
		total += section.length;
		sections.push(section);
	}
	return sections.join("\n\n---\n\n") || (truncated ? "(truncated)" : "(none)");
}
