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
const UPSTREAM_ARTIFACTORY_HEADING_RE = /^\s{0,3}#{1,6}\s+Upstream Artifactory\b.*$/i;
const MAX_SUMMARY_CHARS = 3_000;
const MAX_THINKING_CHARS = 4_000;
const MAX_FILE_ACTIVITY_ITEMS = 40;

function runLane(run: AgentRun): RunLane {
	return run.lane === "gate" || run.lane === "ship" || run.lane === "graph" ? run.lane : "task";
}

function truncate(value: string, max = MAX_REPORT_BODY_CHARS) {
	return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
}

function sessionReportId(runId: string, turnSeq: number) {
	return `session-report:${runId}:${turnSeq}`;
}

function stripUpstreamArtifactSection(text: string) {
	const lines = text.split(/\r?\n/);
	const upstreamIndex = lines.findIndex((line) => UPSTREAM_ARTIFACTORY_HEADING_RE.test(line));
	return (upstreamIndex >= 0 ? lines.slice(0, upstreamIndex) : lines).join("\n");
}

function sanitizeArtifactBodyForContext(body: string) {
	return stripUpstreamArtifactSection(body)
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

function payloadRecord(payload: unknown) {
	return payload && typeof payload === "object" && !Array.isArray(payload)
		? payload as Record<string, unknown>
		: {};
}

function extractPromptSection(text: string, heading: string) {
	const index = text.indexOf(heading);
	if (index < 0) return "";
	const rest = text.slice(index + heading.length).replace(/^\s+/, "");
	const nextHeading = rest.search(/\n##\s+/);
	return (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest).trim();
}

function userMessageSummary(text: string) {
	const withoutUpstream = stripUpstreamArtifactSection(text).split(/\n\nUpstream Artifactory:/)[0]?.trim() ?? text.trim();
	return truncate(
		extractPromptSection(withoutUpstream, "## User request") ||
			extractPromptSection(withoutUpstream, "## Annotation request") ||
			withoutUpstream,
		1200,
	);
}

function uniqueNonEmpty(values: string[]) {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function conversationSummary(events: RunEvent[]) {
	const users = uniqueNonEmpty(
		events
			.filter((event) => event.type === "user_message")
			.map((event) => userMessageSummary(payloadText(event.payload))),
	).slice(-3);
	const assistants = uniqueNonEmpty(assistantSegments(events).map((segment) => truncate(segment, 1200))).slice(-3);
	const lines = ["## Conversation summary"];
	if (users.length) lines.push("", "User:", ...users.map((value) => `- ${value}`));
	if (assistants.length) lines.push("", "Assistant:", ...assistants.map((value) => `- ${value}`));
	if (lines.length === 1) lines.push("", "- No user/assistant text captured.");
	return truncate(lines.join("\n"), MAX_SUMMARY_CHARS);
}

function thinkingSummary(events: RunEvent[]) {
	const thinking = uniqueNonEmpty(
		events
			.filter((event) => event.type === "thinking_delta" || event.type === "thinking_delta_batch")
			.map((event) => payloadText(event.payload)),
	).join("\n");
	return [
		"## Thinking / evaluations / decisions",
		"",
		thinking ? truncate(thinking, MAX_THINKING_CHARS) : "- No thinking/evaluation text captured.",
	].join("\n");
}

function rawToolName(payload: Record<string, unknown>) {
	const tool = payload.tool;
	const nestedTool = tool && typeof tool === "object" && !Array.isArray(tool)
		? (tool as Record<string, unknown>).name
		: undefined;
	const raw = [payload.toolName, payload.name, nestedTool]
		.find((value): value is string => typeof value === "string");
	return raw ?? "";
}

function fileToolLabel(name: string) {
	const normalized = name.toLowerCase().split(/[.:/]/).at(-1) ?? name.toLowerCase();
	if (normalized.startsWith("read")) return "Read";
	if (normalized.startsWith("edit")) return "Edit";
	if (normalized.startsWith("write")) return "Write";
	return "";
}

function collectFilePaths(value: unknown, key = "", paths = new Set<string>()) {
	const normalizedKey = key.toLowerCase();
	const isPathKey = ["path", "filepath", "file", "filename", "targetpath"].includes(normalizedKey);
	const isPathArrayKey = ["paths", "files", "filepaths"].includes(normalizedKey);
	if (typeof value === "string") {
		if (isPathKey || isPathArrayKey) paths.add(value);
		return paths;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectFilePaths(item, key, paths);
		return paths;
	}
	if (!value || typeof value !== "object") return paths;
	for (const [childKey, childValue] of Object.entries(value)) collectFilePaths(childValue, childKey, paths);
	return paths;
}

function fileActivitySummary(events: RunEvent[]) {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const event of events) {
		if (event.type !== "tool_start" && event.type !== "tool_end") continue;
		const payload = payloadRecord(event.payload);
		const label = fileToolLabel(rawToolName(payload));
		if (!label) continue;
		for (const path of collectFilePaths(payload)) {
			const line = `- ${label}: ${truncate(path, 300)}`;
			if (seen.has(line)) continue;
			seen.add(line);
			lines.push(line);
			if (lines.length >= MAX_FILE_ACTIVITY_ITEMS) break;
		}
		if (lines.length >= MAX_FILE_ACTIVITY_ITEMS) break;
	}
	return [
		"## Files read/edited/written",
		"",
		lines.length ? lines.join("\n") : "- No read/edit/write file activity captured.",
	].join("\n");
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
	const events = eventsForTurn(
		(await runEventHub.persistedEvents(run.id))
			.filter((event) => event.type !== "prompt"),
		turnSeq,
	);
	return truncate([
		`Aware generated this fallback session report because no agent-authored report was saved before turn ${turnSeq} ended.`,
		`Run: ${run.id}`,
		`Lane: ${runLane(run)}`,
		"",
		conversationSummary(events),
		"",
		thinkingSummary(events),
		"",
		fileActivitySummary(events),
	].join("\n"));
}

function startedBeforeOrSame(left: AgentRun, right: AgentRun) {
	return left.startedAt.localeCompare(right.startedAt) <= 0;
}

function sameTaskWorktree(left: AgentRun, right: AgentRun) {
	return left.taskId === right.taskId && left.worktreeId === right.worktreeId;
}

function newerArtifact(left: RunArtifact, right: RunArtifact) {
	return left.turnSeq > right.turnSeq || (left.turnSeq === right.turnSeq && left.updatedAt.localeCompare(right.updatedAt) > 0);
}

function lowSignalFallbackArtifact(artifact: RunArtifact) {
	return artifact.metadata?.source === "fallback" &&
		artifact.body.includes("- No user/assistant text captured.") &&
		artifact.body.includes("- No thinking/evaluation text captured.") &&
		artifact.body.includes("- No read/edit/write file activity captured.");
}

export async function collectUpstreamRunIds(run: AgentRun) {
	const runs = (await db.list<AgentRun>("runs")).filter(
		(row) => row.id !== run.id && !row.deletedAt && sameTaskWorktree(row, run),
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
	const upstreamIds = await collectUpstreamRunIds(run);
	const upstream = new Set(upstreamIds);
	if (!upstream.size) return [];
	const latestByRun = new Map<string, RunArtifact>();
	for (const artifact of await db.list<RunArtifact>("runArtifacts")) {
		if (artifact.kind !== "session_report" || !upstream.has(artifact.runId) || lowSignalFallbackArtifact(artifact)) continue;
		const existing = latestByRun.get(artifact.runId);
		if (!existing || newerArtifact(artifact, existing)) latestByRun.set(artifact.runId, artifact);
	}
	return upstreamIds
		.map((runId) => latestByRun.get(runId))
		.filter((artifact): artifact is RunArtifact => Boolean(artifact))
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
