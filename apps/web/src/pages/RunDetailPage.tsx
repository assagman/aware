import type { AgentRun, RunEvent, Task, Worktree } from "@aware/shared";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, apiGet, apiPost } from "../app/api";
import { parsePatchFiles } from "../app/parsePatchFiles";
import {
	getPageState,
	persistScroll,
	restoreScroll,
	setPageState,
} from "../app/pageState";
import {
	getSelectedProjectId,
	getSelectedWorktreeId,
	getSelection,
	setSelectedProjectId,
	setSelectedRunId,
	setSelectedWorktreeId,
} from "../app/selection";
import { BusyIndicator } from "../components/BusyIndicator";
import { SimpleFileDiff as FileDiff } from "../components/SimpleFileDiff";
import { TaskLink } from "../components/TaskLink";

type Payload = Record<string, unknown>;

function textOf(payload: unknown) {
	if (!payload || typeof payload !== "object") return "";
	const p = payload as Payload;
	if (typeof p.text === "string") return p.text;
	if (typeof p.delta === "string") return p.delta;
	if (typeof p.message === "string") return p.message;
	if (typeof p.thinking === "string") return p.thinking;
	if (typeof p.reasoning === "string") return p.reasoning;
	if (typeof p.content === "string") return p.content;
	if (typeof p.content === "object" && p.content !== null) {
		const content = p.content as Payload;
		if (typeof content.thinking === "string") return content.thinking;
		if (typeof content.reasoning === "string") return content.reasoning;
		if (typeof content.text === "string") return content.text;
	}
	if (
		p.data &&
		typeof p.data === "object" &&
		"text" in p.data &&
		typeof (p.data as Payload).text === "string"
	)
		return (p.data as Payload).text as string;
	return "";
}

function eventType(event: RunEvent) {
	return event.type.toLowerCase().replace(/[.:]/g, "_");
}

function extractTextDeep(value: unknown): string {
	const direct = textOf(value);
	if (direct) return direct;
	if (Array.isArray(value))
		return value.map(extractTextDeep).filter(Boolean).join("");
	const p = asPayload(value);
	for (const key of [
		"assistant",
		"message",
		"delta",
		"chunk",
		"data",
		"result",
		"response",
		"output",
	]) {
		if (p[key] === value) continue;
		const text = extractTextDeep(p[key]);
		if (text) return text;
	}
	return "";
}

function isAssistantEvent(event: RunEvent) {
	const type = eventType(event);
	if (isThinkingEvent(event)) return false;
	if (type.includes("tool")) return false;
	return (
		type === "text_delta" ||
		type.includes("assistant") ||
		type.includes("message_delta") ||
		type.includes("content_delta") ||
		type.includes("response_delta")
	);
}

function isThinkingEvent(event: RunEvent) {
	const type = eventType(event);
	return type.includes("thinking") || type.includes("reason");
}

function isToolStartEvent(event: RunEvent) {
	const type = eventType(event);
	return (
		(type === "tool_start" ||
			type.includes("tool_call") ||
			type.includes("tool_use") ||
			type.includes("tool_start")) &&
		!isToolEndEvent(event)
	);
}

function isToolEndEvent(event: RunEvent) {
	const type = eventType(event);
	return (
		type === "tool_end" ||
		type.includes("tool_result") ||
		type.includes("tool_response") ||
		type.includes("tool_end")
	);
}

function isHiddenEvent(event: RunEvent) {
	const type = eventType(event);
	return (
		type === "system" ||
		type === "model" ||
		type === "agent_start" ||
		type === "turn_start" ||
		type === "turn_end" ||
		type === "idle" ||
		type.includes("system_message")
	);
}

function mapPromptTextToUserEvents(events: RunEvent[]) {
	const textByUserEventId = new Map<string, string>();
	const consumedPromptEventIds = new Set<string>();
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		if (!event || event.type !== "user_message") continue;
		for (
			let promptIndex = index + 1;
			promptIndex < events.length;
			promptIndex += 1
		) {
			const candidate = events[promptIndex];
			if (!candidate || candidate.type === "user_message") break;
			if (candidate.type !== "prompt") continue;
			const promptText = textOf(candidate.payload);
			if (promptText) {
				textByUserEventId.set(event.id, promptText);
				consumedPromptEventIds.add(candidate.id);
			}
			break;
		}
	}
	return { textByUserEventId, consumedPromptEventIds };
}

function jsonText(value: unknown) {
	return typeof value === "string"
		? value
		: JSON.stringify(value ?? {}, null, 2);
}

function jsonPreview(value: unknown, max = 200) {
	const text = jsonText(value);
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

const TOOL_DETAIL_PREVIEW_CHARS = 8000;

function valueToMarkdownPreview(value: unknown, max = TOOL_DETAIL_PREVIEW_CHARS) {
	const text = jsonText(value);
	if (text.length > max) return fencedCode(`${text.slice(0, max)}\n…[truncated]`);
	return valueToMarkdown(value);
}

function parseJsonString(value: string) {
	const trimmed = value.trim();
	if (!trimmed || !/^[{[]/.test(trimmed)) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

function escapeMarkdown(value: string) {
	return value.replace(/([\\`*_{}\[\]()#+.!|-])/g, "\\$1");
}

function fencedCode(value: string) {
	const fence = value.includes("```") ? "````" : "```";
	return `${fence}\n${value}\n${fence}`;
}

function primitiveMarkdown(value: unknown) {
	if (value === null) return "_null_";
	if (value === undefined) return "_Not provided_";
	if (typeof value === "boolean") return value ? "Yes" : "No";
	if (typeof value === "number" || typeof value === "bigint") return String(value);
	if (typeof value !== "string") return undefined;
	const parsed = parseJsonString(value);
	if (parsed !== undefined) return valueToMarkdown(parsed);
	if (value.includes("\n")) return fencedCode(value);
	return value ? escapeMarkdown(value) : "_Empty_";
}

function valueToMarkdown(value: unknown): string {
	const primitive = primitiveMarkdown(value);
	if (primitive !== undefined) return primitive;
	if (Array.isArray(value)) {
		if (!value.length) return "_No items._";
		return value
			.map((item) => {
				const rendered = valueToMarkdown(item);
				return rendered.includes("\n") ? `-\n${indentMarkdown(rendered)}` : `- ${rendered}`;
			})
			.join("\n");
	}
	const p = asPayload(value);
	const entries = Object.entries(p).filter(([, item]) => item !== undefined);
	if (!entries.length) return "_No details._";
	return entries
		.map(([key, item]) => {
			const rendered = valueToMarkdown(item);
			const label = escapeMarkdown(labelize(key));
			return rendered.includes("\n")
				? `- **${label}:**\n${indentMarkdown(rendered)}`
				: `- **${label}:** ${rendered}`;
		})
		.join("\n");
}

function indentMarkdown(value: string) {
	return value
		.split("\n")
		.map((line) => (line ? `  ${line}` : line))
		.join("\n");
}

function labelize(key: string) {
	return key
		.replace(/[_-]+/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/^./, (char) => char.toUpperCase());
}

function isSafeHref(href: string) {
	return /^(https?:|mailto:|\/|#)/i.test(href);
}

const markdownComponents: Components = {
	a({ href, children, ...props }) {
		if (!href || !isSafeHref(href)) return <span>{children}</span>;
		return (
			<a {...props} href={href} target="_blank" rel="noreferrer">
				{children}
			</a>
		);
	},
	table({ children }) {
		return (
			<div className="markdown-table-scroll">
				<table>{children}</table>
			</div>
		);
	},
};

function normalizeMarkdown(text: string) {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\|\s*(?=\|[^\n]+\|\s*\n\|?\s*:?-{3,})/g, "|\n\n");
}

function MarkdownText({
	text,
	className = "",
}: {
	text: string;
	className?: string;
}) {
	return (
		<div className={`markdown-text ${className}`.trim()}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[rehypeSanitize]}
				components={markdownComponents}
			>
				{normalizeMarkdown(text)}
			</ReactMarkdown>
		</div>
	);
}

function activeAgentLabel(run: AgentRun | undefined, _events: RunEvent[]) {
	if (!run) return "—";
	return run.mainAgentName ?? "Main agent";
}

function errorText(payload: unknown) {
	return textOf(payload) || jsonPreview(payload, 4000);
}

type ProcessState = "live" | "stalled" | "idle";

const RUN_STALLED_AFTER_MS = 30_000;
const RUN_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

function formatDuration(ms: number) {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function ProcessIndicator({ state }: { state: ProcessState }) {
	const label = state === "live" ? "Live" : state === "stalled" ? "Stalled" : "Idle";
	return (
		<span className={`run-process-indicator ${state}`}>
			<span aria-hidden="true" />
			{label}
		</span>
	);
}

function toolName(payload: unknown, fallback: string) {
	const p = asPayload(payload);
	return String(p.toolName ?? p.name ?? p.tool ?? fallback);
}

function toolArgs(payload: unknown) {
	const p = asPayload(payload);
	return p.args ?? p.arguments ?? p.input ?? p.params ?? p.parameters ?? {};
}

function argText(value: unknown) {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	return undefined;
}

function lineRange(args: Payload) {
	const direct = argText(args.range ?? args.lineRange ?? args.lines);
	if (direct) return direct;
	const start = Number(args.startLine ?? args.line ?? args.offset);
	const end = Number(args.endLine);
	const limit = Number(args.limit);
	if (Number.isFinite(start) && Number.isFinite(end)) return `${start}-${end}`;
	if (Number.isFinite(start) && Number.isFinite(limit))
		return `${start}-${start + limit - 1}`;
	if (Number.isFinite(start)) return String(start);
	return undefined;
}

function toolArgsSummary(name: string, args: unknown) {
	if (typeof args === "string") {
		const parsed = asPayload(args);
		if (!Object.keys(parsed).length) return args;
		args = parsed;
	}
	const p = asPayload(args);
	const normalized = name.toLowerCase();
	const path = argText(p.path ?? p.filePath ?? p.file_path ?? p.filename);
	if (normalized.includes("bash") || normalized.includes("shell")) {
		return argText(p.command ?? p.cmd ?? p.script ?? p.input) ?? "";
	}
	if (normalized.includes("read")) {
		return [path, lineRange(p)].filter(Boolean).join(" ");
	}
	if (normalized.includes("edit") || normalized.includes("write")) {
		return path ?? "";
	}
	if (normalized.includes("grep") || normalized.includes("search")) {
		return [argText(p.pattern ?? p.query), path, argText(p.include)]
			.filter(Boolean)
			.join(" ");
	}
	if (normalized.includes("glob") || normalized.includes("find")) {
		return [argText(p.pattern), path].filter(Boolean).join(" ");
	}
	const entries = Object.entries(p)
		.map(([key, value]) => {
			const text = argText(value);
			return text ? `${key}=${text}` : undefined;
		})
		.filter(Boolean);
	return entries.join(" ");
}

function toolKey(event: RunEvent) {
	const p = asPayload(event.payload);
	return String(
		p.toolCallId ??
			p.callId ??
			p.id ??
			p.toolUseId ??
			`${toolName(event.payload, event.type)}:${event.seq}`,
	);
}

function toolFailed(payload: unknown) {
	const p = payload as Payload;
	return Boolean(p.error || p.isError || p.failed || p.exitCode);
}

function toolOutput(payload: unknown) {
	const p = payload as Payload;
	return p.result ?? p.output ?? p.error ?? p;
}

function asPayload(value: unknown): Payload {
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as unknown;
			return parsed && typeof parsed === "object" ? (parsed as Payload) : {};
		} catch {
			return {};
		}
	}
	return value && typeof value === "object" ? (value as Payload) : {};
}

function stringifyArg(value: unknown) {
	return typeof value === "string" ? value : undefined;
}

function firstString(payload: unknown, keys: string[]) {
	const p = asPayload(payload);
	for (const key of keys) {
		const value = p[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function splitPatchLines(text: string) {
	if (!text) return [];
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function prefixedPatchLines(prefix: string, text: string) {
	return splitPatchLines(text).map((line) => `${prefix}${line}`);
}

function buildEditPatch(args: unknown) {
	const p = asPayload(args);
	const path = firstString(p, ["path", "filePath", "file_path", "filename"]);
	const oldText =
		firstString(p, ["oldText", "old_text", "oldString", "old_string"]) ??
		stringifyArg(p.old);
	const newText =
		firstString(p, [
			"newText",
			"new_text",
			"newString",
			"new_string",
			"replacement",
		]) ?? stringifyArg(p.new);
	if (!path || oldText === undefined || newText === undefined) return undefined;
	const oldLines = splitPatchLines(oldText);
	const newLines = splitPatchLines(newText);
	const oldCount = oldLines.length;
	const newCount = newLines.length;
	return [
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -1,${oldCount} +1,${newCount} @@`,
		...prefixedPatchLines("-", oldText),
		...prefixedPatchLines("+", newText),
		"",
	].join("\n");
}

function buildWritePatch(args: unknown) {
	const p = asPayload(args);
	const path = firstString(p, ["path", "filePath", "file_path", "filename"]);
	const content =
		firstString(p, ["content", "text", "data", "newText", "new_text"]) ??
		stringifyArg(p.input);
	if (!path || content === undefined) return undefined;
	const newLines = splitPatchLines(content);
	return [
		`diff --git a/${path} b/${path}`,
		"--- /dev/null",
		`+++ b/${path}`,
		`@@ -0,0 +1,${newLines.length} @@`,
		...prefixedPatchLines("+", content),
		"",
	].join("\n");
}

function patchFromPayload(value: unknown): string | undefined {
	const direct = firstString(value, ["patch", "diff"]);
	if (direct) return direct;
	return firstString(toolOutput(value), ["patch", "diff"]);
}

function parsePatch(patch: string) {
	try {
		return parsePatchFiles(patch, "tool-edit-diff", false).flatMap(
			(parsed) => parsed.files,
		);
	} catch {
		return [];
	}
}

function ToolDiff({ patch }: { patch: string }) {
	const files = useMemo(() => parsePatch(patch), [patch]);
	if (!files.length) return <pre>{patch}</pre>;
	return (
		<div className="tool-diff-visual">
			{files.map((file) => (
				<FileDiff
					key={`${file.name}-${file.prevName ?? ""}`}
					fileDiff={file}
					disableWorkerPool
				/>
			))}
		</div>
	);
}

function AnnotationSummary({ event }: { event: RunEvent }) {
	const annotationList = Array.isArray((event.payload as Payload)?.annotations)
		? ((event.payload as Payload).annotations as Payload[])
		: [];
	if (!annotationList.length) return null;
	return (
		<section className="chat-bubble annotations-summary message-annotations">
			<strong>Sent annotations</strong>
			<ul>
				{annotationList.map((a) => (
					<li key={String(a.id)}>
						{String(a.kind)} {String(a.filePath ?? "(missing file)")}
						{a.startLine
							? `:${String(a.startLine)}${a.endLine ? `-${String(a.endLine)}` : ""}`
							: ""}
						— {String(a.text ?? "")}
					</li>
				))}
			</ul>
		</section>
	);
}

const toolPalette = [
	"tool-color-0",
	"tool-color-1",
	"tool-color-2",
	"tool-color-3",
	"tool-color-4",
	"tool-color-5",
];

function toolColorClass(name: string) {
	const normalized = name.toLowerCase();
	if (normalized.includes("read")) return "tool-read";
	if (normalized.includes("bash") || normalized.includes("shell")) return "tool-bash";
	if (normalized.includes("edit")) return "tool-edit";
	if (normalized.includes("write")) return "tool-write";
	let hash = 0;
	for (let i = 0; i < name.length; i++)
		hash = (hash * 31 + name.charCodeAt(i)) | 0;
	return toolPalette[Math.abs(hash) % toolPalette.length];
}

function isShellTool(name: string) {
	const normalized = name.toLowerCase();
	return normalized.includes("bash") || normalized.includes("shell");
}

function BashCommandSummary({ command }: { command: string }) {
	let commandStart = true;
	return (
		<code className="tool-summary-code bash-summary-code">
			{command.split(/(\s+|&&|\|\||[|;&()<>])/g).filter(Boolean).map((part, index) => {
				if (/^\s+$/.test(part)) return part;
				if (/^(?:&&|\|\||[|;&()<>])$/.test(part)) {
					commandStart = true;
					return <span key={index} className="shell-token shell-operator">{part}</span>;
				}
				let className = "shell-token";
				if (commandStart) {
					className += " shell-command";
					commandStart = false;
				} else if (/^-{1,2}\w/.test(part)) className += " shell-flag";
				else if (/^(['"]).*\1$/.test(part)) className += " shell-string";
				else if (part.includes("/") || part.includes(".")) className += " shell-path";
				return <span key={index} className={className}>{part}</span>;
			})}
		</code>
	);
}

function ToolSummary({ name, summary }: { name: string; summary: string }) {
	if (!summary) return null;
	return isShellTool(name) ? <BashCommandSummary command={summary} /> : <em>{summary}</em>;
}

function toolContentText(value: unknown) {
	if (typeof value === "string") return value;
	const p = asPayload(value);
	const content = p.content;
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				const itemPayload = asPayload(item);
				return typeof itemPayload.text === "string" ? itemPayload.text : "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return argText(p.text ?? p.stdout ?? p.stderr ?? p.message) ?? "";
}

function lineCount(text: string) {
	if (!text) return 0;
	return text.replace(/\n$/, "").split(/\r?\n/).length;
}

function readRangeSummary(args: unknown, result: unknown) {
	const p = asPayload(args);
	const offset = Number(p.offset ?? p.startLine ?? p.line ?? 1);
	const textLines = lineCount(toolContentText(result));
	if (!Number.isFinite(offset) || !textLines) return undefined;
	return `${offset}-${offset + textLines - 1}`;
}

function ToolChips({ items }: { items: Array<[string, unknown]> }) {
	const visible = items.filter(([, value]) => value !== undefined && value !== "");
	if (!visible.length) return null;
	return (
		<div className="tool-chip-row">
			{visible.map(([label, value]) => (
				<span key={label} className="tool-chip"><strong>{label}</strong>{String(value)}</span>
			))}
		</div>
	);
}

function StructuredValue({ value }: { value: unknown }) {
	const text = toolContentText(value);
	if (text) return <MarkdownText text={text} className="tool-detail-markdown" />;
	const p = asPayload(value);
	const entries = Object.entries(p).filter(([, item]) => item !== undefined);
	if (!entries.length) return <p className="muted">No details.</p>;
	return (
		<div className="tool-kv-grid">
			{entries.map(([key, item]) => (
				<div key={key}>
					<strong>{key}</strong>
					<pre>{jsonPreview(item, 4000)}</pre>
				</div>
			))}
		</div>
	);
}

function ToolArgumentsView({ name, args, patch }: { name: string; args: unknown; patch?: string | undefined }) {
	const normalized = name.toLowerCase();
	const p = asPayload(args);
	if (isShellTool(name)) return <pre className="tool-command-detail">{argText(p.command ?? p.cmd ?? p.script ?? p.input) ?? jsonPreview(args, 4000)}</pre>;
	if (normalized.includes("edit") || normalized.includes("write")) return <ToolChips items={[["path", p.path ?? p.filePath ?? p.file_path], ["changed lines", patch ? lineCount(patch) : undefined]]} />;
	return <StructuredValue value={args} />;
}

function ToolResultView({ name, args, result, patch }: { name: string; args: unknown; result: unknown; patch?: string | undefined }) {
	const normalized = name.toLowerCase();
	const details = asPayload(asPayload(result).details);
	const text = toolContentText(result);
	if ((normalized.includes("edit") || normalized.includes("write")) && patch) {
		return (
			<>
				<ToolDiff patch={patch} />
				{text ? <MarkdownText text={text} className="tool-detail-markdown" /> : null}
			</>
		);
	}
	if (normalized.includes("read")) {
		return (
			<>
				<ToolChips items={[["path", details.path ?? asPayload(args).path], ["total lines", details.lines ?? details.totalLines], ["read lines", lineCount(text)], ["range", readRangeSummary(args, result)]]} />
				{text ? <MarkdownText text={text} className="tool-detail-markdown" /> : <p className="muted">No output.</p>}
			</>
		);
	}
	if (isShellTool(name)) {
		return (
			<>
				<ToolChips items={[["exit", details.exitCode ?? asPayload(result).exitCode], ["status", details.status]]} />
				<pre className="tool-output-block">{text || "(no output)"}</pre>
			</>
		);
	}
	return <StructuredValue value={result} />;
}

function ToolBlock({ start, end, forceOpen = false }: { start: RunEvent; end?: RunEvent; forceOpen?: boolean }) {
	const name = toolName(start.payload, "tool");
	const args = toolArgs(start.payload);
	const argsSummary = toolArgsSummary(name, args);
	const failed = end ? toolFailed(end.payload) : false;
	const status = end ? (failed ? "failed" : "success") : "running";
	const normalizedName = name.toLowerCase();
	const isEdit = normalizedName.includes("edit");
	const isWrite = normalizedName.includes("write");
	const result = end ? toolOutput(end.payload) : undefined;
	const resultPatch = end ? patchFromPayload(end.payload) : undefined;
	const toolPatch = failed && isEdit
		? undefined
		: (resultPatch ??
			(isEdit ? buildEditPatch(args) : undefined) ??
			(isWrite ? buildWritePatch(args) : undefined));
	return (
		<details
			className={`chat-bubble tool-event tool-${status} ${toolColorClass(name)}`}
			open={forceOpen}
		>
			<summary>
				<strong>{name}</strong>
				<ToolSummary name={name} summary={argsSummary} />
			</summary>
			<section className="tool-details-grid">
				<div className="tool-detail-card">
					<h4>Arguments</h4>
					<ToolArgumentsView name={name} args={args} patch={toolPatch} />
				</div>
				{end && result !== undefined ? (
					<div className="tool-detail-card">
						<h4>Result</h4>
						<ToolResultView name={name} args={args} result={result} patch={toolPatch} />
					</div>
				) : null}
			</section>
		</details>
	);
}

const ChatTimeline = memo(function ChatTimeline({ events }: { events: RunEvent[] }) {
	const ordered = [...events].sort((a, b) => a.seq - b.seq);
	const { textByUserEventId, consumedPromptEventIds } =
		mapPromptTextToUserEvents(ordered);
	const toolEnds = new Map<string, RunEvent>();
	for (const event of ordered) {
		if (isToolEndEvent(event)) toolEnds.set(toolKey(event), event);
	}
	const latestVisibleSeq = [...ordered].reverse().find((event) => !isHiddenEvent(event) && !isToolEndEvent(event))?.seq;
	const rendered: ReactNode[] = [];
	let assistantBuffer = "";
	let assistantKey = "";
	let thinkingBuffer = "";
	let thinkingKey = "";
	function flushAssistant() {
		if (!assistantBuffer) return;
		rendered.push(
			<section
				key={assistantKey}
				className="chat-bubble assistant-message message-assistant"
			>
				<strong>Assistant</strong>
				<MarkdownText text={assistantBuffer} />
			</section>,
		);
		assistantBuffer = "";
	}
	function flushThinking() {
		if (!thinkingBuffer) return;
		rendered.push(
			<details
				key={thinkingKey}
				className="chat-bubble thinking-block message-thinking"
			>
				<summary>Assistant thinking</summary>
				<MarkdownText text={thinkingBuffer} className="thinking-text" />
			</details>,
		);
		thinkingBuffer = "";
	}
	for (const event of ordered) {
		if (isHiddenEvent(event)) continue;
		if (isAssistantEvent(event)) {
			const text = extractTextDeep(event.payload);
			if (text) {
				flushThinking();
				assistantKey ||= event.id;
				assistantBuffer += text;
				continue;
			}
		}
		if (isThinkingEvent(event)) {
			const text = extractTextDeep(event.payload);
			if (!text) continue;
			flushAssistant();
			thinkingKey ||= event.id;
			thinkingBuffer += text;
			continue;
		}
		flushAssistant();
		flushThinking();
		if (isToolEndEvent(event)) continue;
		if (event.type === "user_message") {
			rendered.push(
				<section
					key={event.id}
					className="chat-bubble user-message message-user"
				>
					<strong>User</strong>
					<MarkdownText
						text={textByUserEventId.get(event.id) || textOf(event.payload)}
					/>
				</section>,
			);
		} else if (event.type === "annotations") {
			rendered.push(<AnnotationSummary key={event.id} event={event} />);
		} else if (event.type === "prompt") {
			if (!consumedPromptEventIds.has(event.id)) {
				rendered.push(
					<section key={event.id} className="chat-bubble user-message message-user">
						<strong>User</strong>
						<MarkdownText text={textOf(event.payload)} />
					</section>,
				);
			}
		} else if (isToolStartEvent(event)) {
			const end = toolEnds.get(toolKey(event));
			rendered.push(
				end ? (
					<ToolBlock key={event.id} start={event} end={end} forceOpen={false} />
				) : (
					<ToolBlock key={event.id} start={event} forceOpen={event.seq === latestVisibleSeq} />
				),
			);
		} else if (event.type === "result") {
			continue;
		} else if (event.type === "error") {
			rendered.push(
				<section key={event.id} className="chat-bubble error message-error">
					<strong>Error</strong>
					<MarkdownText text={errorText(event.payload)} />
				</section>,
			);
		} else {
			continue;
		}
	}
	flushAssistant();
	flushThinking();
	return <div className="run-chat-timeline">{rendered}</div>;
});

function RunInputBar({
	initialMessage,
	runId,
	canMarkDone,
	markingDone,
	sendingMessage,
	onMarkDone,
	onSend,
}: {
	initialMessage: string;
	runId: string;
	canMarkDone: boolean;
	markingDone: boolean;
	sendingMessage: boolean;
	onMarkDone: () => Promise<void>;
	onSend: (message: string) => Promise<void>;
}) {
	const [draft, setDraft] = useState(initialMessage);
	useEffect(() => {
		const timer = window.setTimeout(() => setPageState("runs", { message: draft }), 250);
		return () => window.clearTimeout(timer);
	}, [draft]);
	async function sendDraft() {
		const next = draft.trim();
		if (!next || !runId || sendingMessage) return;
		await onSend(draft);
		setDraft("");
		setPageState("runs", { message: "" });
	}
	return (
		<div className="run-input-bar">
			<div className="run-input-actions">
				<button
					type="button"
					onClick={() => void onMarkDone()}
					disabled={!canMarkDone || markingDone}
				>
					{markingDone ? "Marking…" : "Done"}
				</button>
			</div>
			<textarea
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				placeholder="Steer this run..."
				onKeyDown={(e) => {
					if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
						e.preventDefault();
						void sendDraft();
					}
				}}
			/>
			{sendingMessage ? <BusyIndicator label="Sending" /> : null}
			<button
				type="button"
				onClick={sendDraft}
				disabled={!draft.trim() || !runId || sendingMessage}
			>
				{sendingMessage ? "Sending…" : "Send"}
			</button>
		</div>
	);
}

const initialRunsState = getPageState("runs", { message: "", runId: "", worktreeFilter: "all" });

export function RunDetailPage() {
	const [runs, setRuns] = useState<AgentRun[]>([]);
	const [tasks, setTasks] = useState<Task[]>([]);
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [projectId, setProjectIdState] = useState(getSelectedProjectId("runs"));
	const [worktreeFilter, setWorktreeFilter] = useState(
		getSelectedWorktreeId("runs") || initialRunsState.worktreeFilter || "all",
	);
	const [runId, setRunId] = useState(getSelection().selectedRunId || initialRunsState.runId);
	const [events, setEvents] = useState<RunEvent[]>([]);
	const [loadingRuns, setLoadingRuns] = useState(false);
	const [loadingEvents, setLoadingEvents] = useState(false);
	const [sendingMessage, setSendingMessage] = useState(false);
	const [cancellingRun, setCancellingRun] = useState(false);
	const [markingDone, setMarkingDone] = useState(false);
	const [nowMs, setNowMs] = useState(Date.now());
	const bottomRef = useRef<HTMLDivElement | null>(null);
	const chatScrollRef = useRef<HTMLDivElement | null>(null);
	const currentRunIdRef = useRef(runId);
	const eventsRequestRef = useRef(0);
	currentRunIdRef.current = runId;
	const worktreeProjectIds = useMemo(
		() => Object.fromEntries(worktrees.map((w) => [w.id, w.projectId])),
		[worktrees],
	);
	const visibleRuns = useMemo(
		() =>
			runs.filter((run) => {
				if (worktreeFilter !== "all") return run.worktreeId === worktreeFilter;
				if (!projectId) return true;
				return worktreeProjectIds[run.worktreeId] === projectId;
			}),
		[projectId, runs, worktreeFilter, worktreeProjectIds],
	);
	const selectedRun = useMemo(
		() => visibleRuns.find((r) => r.id === runId),
		[visibleRuns, runId],
	);
	const taskById = useMemo(
		() => Object.fromEntries(tasks.map((task) => [task.id, task])),
		[tasks],
	);
	const selectedTask = useMemo(
		() => (selectedRun ? taskById[selectedRun.taskId] : undefined),
		[taskById, selectedRun],
	);
	const worktreeNames = useMemo(
		() =>
			Object.fromEntries(
				worktrees.map((w) => [
					w.id,
					w.path.split("/").filter(Boolean).at(-1) || w.path,
				]),
			),
		[worktrees],
	);
	const selectedEvents = useMemo(
		() => events.filter((event) => event.runId === runId),
		[events, runId],
	);
	const activeAgent = useMemo(
		() => activeAgentLabel(selectedRun, selectedEvents),
		[selectedRun, selectedEvents],
	);
	const processState: ProcessState = useMemo(() => {
		if (selectedRun?.status !== "running") return "idle";
		const latestEvent = selectedEvents.at(-1);
		if (!latestEvent) return "live";
		const ageMs = nowMs - new Date(latestEvent.createdAt).getTime();
		return ageMs > RUN_STALLED_AFTER_MS ? "stalled" : "live";
	}, [selectedEvents, nowMs, selectedRun?.status]);
	const stalledNotice = useMemo(() => {
		if (selectedRun?.status !== "running") return undefined;
		const latestEvent = selectedEvents.at(-1);
		if (!latestEvent) return undefined;
		const ageMs = nowMs - new Date(latestEvent.createdAt).getTime();
		if (ageMs <= RUN_STALLED_AFTER_MS) return undefined;
		const remainingMs = Math.max(0, RUN_INACTIVITY_TIMEOUT_MS - ageMs);
		return {
			idleFor: formatDuration(ageMs),
			remaining: formatDuration(remainingMs),
			lastEventType: latestEvent.type,
		};
	}, [selectedEvents, nowMs, selectedRun?.status]);
	async function loadRuns(
		nextFilter = worktreeFilter,
		options: { silent?: boolean } = {},
	) {
		if (!projectId) {
			setRuns([]);
			setRunId("");
			setSelectedRunId("");
			setEvents([]);
			setLoadingRuns(false);
			setLoadingEvents(false);
			return;
		}
		if (!options.silent) setLoadingRuns(true);
		try {
			const rows = await apiGet<AgentRun[]>(`/runs?worktreeId=${nextFilter}`);
			setRuns(rows);
			if ((!runId || !rows.some((run) => run.id === runId)) && rows[0]) {
				setRunId(rows[0].id);
				setSelectedRunId(rows[0].id);
				setPageState("runs", { runId: rows[0].id });
			}
			if (!rows.length) {
				setRunId("");
				setSelectedRunId("");
				setPageState("runs", { runId: "" });
				setEvents([]);
			}
		} finally {
			if (!options.silent) setLoadingRuns(false);
		}
	}
	async function loadTasks() {
		setTasks(await apiGet<Task[]>("/tasks"));
	}
	async function loadEvents(id = runId, options: { silent?: boolean } = {}) {
		if (!id) return;
		const requestId = ++eventsRequestRef.current;
		if (!options.silent) setLoadingEvents(true);
		try {
			const nextEvents = await apiGet<RunEvent[]>(`/runs/${id}/events`);
			if (currentRunIdRef.current !== id || eventsRequestRef.current !== requestId)
				return;
			setEvents(nextEvents);
			if (!options.silent) {
				window.requestAnimationFrame(() =>
					restoreScroll(`runs-chat-scroll:${id}`, chatScrollRef.current),
				);
			}
			setSelectedRunId(id);
		} finally {
			if (!options.silent && currentRunIdRef.current === id) setLoadingEvents(false);
		}
	}
	useEffect(() => {
		void loadRuns(worktreeFilter);
		void loadTasks();
		void apiGet<Worktree[]>("/worktrees").then(setWorktrees);
	}, [projectId, worktreeFilter]);
	useEffect(() => {
		const syncSelection = () => {
			const nextProjectId = getSelectedProjectId("runs");
			const nextWorktreeFilter = getSelectedWorktreeId("runs") || "all";
			if (nextProjectId !== projectId) {
				chooseProject(nextProjectId);
				return;
			}
			if (nextWorktreeFilter !== worktreeFilter) chooseWorktree(nextWorktreeFilter);
		};
		window.addEventListener("aware-selection", syncSelection);
		return () => window.removeEventListener("aware-selection", syncSelection);
	}, [projectId, worktreeFilter]);
	useEffect(() => {
		const timer = window.setInterval(() => setNowMs(Date.now()), 5000);
		return () => window.clearInterval(timer);
	}, []);
	useEffect(() => {
		setEvents([]);
	}, [runId]);
	function chooseProject(id: string) {
		setSelectedProjectId(id, "runs");
		setProjectIdState(id);
		setSelectedWorktreeId("all", "runs");
		setWorktreeFilter("all");
		setPageState("runs", { worktreeFilter: "all" });
	}
	function chooseWorktree(id: string) {
		setSelectedWorktreeId(id, "runs");
		setWorktreeFilter(id);
		setPageState("runs", { worktreeFilter: id });
	}
	useEffect(() => {
		if (!projectId || !runId) return;
		let closed = false;
		let fallbackTimer: number | undefined;
		void loadEvents(runId);
		void loadRuns();
		const startPolling = () => {
			if (fallbackTimer || closed) return;
			fallbackTimer = window.setInterval(
				() => {
					void loadRuns(worktreeFilter, { silent: true });
					void loadEvents(runId, { silent: true });
				},
				selectedRun?.status === "running" ? 1000 : 3000,
			);
		};
		if (typeof EventSource === "undefined") {
			startPolling();
			return () => {
				closed = true;
				if (fallbackTimer) window.clearInterval(fallbackTimer);
			};
		}
		const source = new EventSource(`${API_BASE}/runs/${runId}/stream`);
		source.onmessage = () => undefined;
		source.onerror = () => {
			source.close();
			startPolling();
		};
		const handleEvent = (event: MessageEvent<string>) => {
			if (closed || currentRunIdRef.current !== runId) return;
			try {
				const seq = Number(event.lastEventId);
				const payload = JSON.parse(event.data) as unknown;
				const item: RunEvent = {
					id: `${runId}:${seq}`,
					runId,
					seq,
					type: event.type,
					payload,
					createdAt: new Date().toISOString(),
				};
				setEvents((current) =>
					current.some((existing) => existing.seq === item.seq)
						? current
						: [...current, item].sort((a, b) => a.seq - b.seq),
				);
				if (event.type === "worktree_switched") {
					void loadRuns(worktreeFilter, { silent: true });
					void apiGet<Worktree[]>("/worktrees").then(setWorktrees);
				}
				if (event.type === "result" || event.type === "error") {
					void loadRuns(worktreeFilter, { silent: true });
					void loadTasks();
				}
			} catch {
				source.close();
				startPolling();
			}
		};
		for (const type of [
			"text_delta",
			"thinking_delta",
			"message_delta_batch",
			"thinking_delta_batch",
			"tool_start",
			"tool_end",
			"task_start",
			"task_end",
			"user_message",
			"annotations",
			"prompt",
			"result",
			"error",
			"model",
			"worktree_switched",
			"agent_start",
			"turn_start",
			"turn_end",
			"idle",
		]) {
			source.addEventListener(type, handleEvent as EventListener);
		}
		return () => {
			closed = true;
			source.close();
			if (fallbackTimer) window.clearInterval(fallbackTimer);
		};
	}, [projectId, runId, selectedRun?.status, worktreeFilter]);
	useEffect(() => {
		if (selectedRun?.status === "running")
			bottomRef.current?.scrollIntoView({ block: "end" });
	}, [selectedEvents.length, selectedRun?.status]);
	async function cancelRun() {
		if (!runId || cancellingRun) return;
		setCancellingRun(true);
		try {
		await apiPost(`/runs/${runId}/cancel`, {});
		await loadRuns();
		await loadEvents(runId);
		} finally {
			setCancellingRun(false);
		}
	}
	async function markSelectedRunDone() {
		if (
			!selectedRun ||
			selectedRun.status !== "done" ||
			selectedTask?.status !== "need_review" ||
			markingDone
		)
			return;
		setMarkingDone(true);
		try {
			await apiPost(`/tasks/${selectedRun.taskId}/done`, {});
			await Promise.all([loadRuns(worktreeFilter, { silent: true }), loadTasks()]);
		} finally {
			setMarkingDone(false);
		}
	}
	const sendMessage = useCallback(async (nextMessage: string) => {
		if (!runId || !nextMessage.trim() || sendingMessage) return;
		setSendingMessage(true);
		try {
			await apiPost(`/runs/${runId}/messages`, { message: nextMessage });
			await loadEvents(runId);
		} finally {
			setSendingMessage(false);
		}
	}, [runId, sendingMessage]);
	return (
		<section id="runs" className="runs-shell full-workspace">
			<div className="card run-page">
			<aside className="runs-sidebar">
				<div className="runs-sidebar-head">
					<h2>Runs</h2>
					{loadingRuns ? <BusyIndicator label="Loading runs" /> : null}
				</div>
				<div className="runs-list" aria-label="Runs list">
					{!projectId ? <p className="empty-state">No project selected.</p> : null}
					{projectId && !loadingRuns && visibleRuns.length === 0 ? <p className="empty-state">No runs.</p> : null}
					{visibleRuns.map((r) => {
						const task = taskById[r.taskId];
						return (
							<div
								key={r.id}
								role="button"
								tabIndex={0}
								className={r.id === runId ? "run-row selected" : "run-row"}
								onClick={() => { setRunId(r.id); setSelectedRunId(r.id); setPageState("runs", { runId: r.id }); }}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										setRunId(r.id);
										setSelectedRunId(r.id);
										setPageState("runs", { runId: r.id });
									}
								}}
							>
								<strong>{r.id.slice(0, 8)}</strong>
								<span className={`task-status status-${r.status}`}>
									{r.status}
								</span>
								<small>
									<TaskLink taskId={r.taskId} projectId={task?.projectId}>
										{task?.title ?? `task ${r.taskId.slice(0, 8)}`}
									</TaskLink>
								</small>
								<small>{worktreeNames[r.worktreeId] ?? "worktree"}</small>
							</div>
						);
					})}
				</div>
			</aside>
			<div className="run-main">
				<div className="run-header">
					<div>
						<h2>Run chat</h2>
						{selectedRun ? (
							<small>run {selectedRun.id}</small>
						) : (
							<small>No run selected</small>
						)}
					</div>
					{selectedRun ? (
						<>
							<span>
								Status: <strong>{selectedRun.status}</strong>
							</span>
							<span>
								Task: <strong><TaskLink taskId={selectedRun.taskId} projectId={selectedTask?.projectId}>{selectedTask?.title ?? selectedRun.taskId.slice(0, 8)}</TaskLink></strong>
							</span>
							<span>
								Main agent: <strong>{activeAgent}</strong>
							</span>
						</>
					) : null}
					{loadingEvents ? <BusyIndicator label="Loading events" /> : null}
					{selectedRun?.readOnly ? <span className="run-readonly-badge">Delegated read-only run</span> : null}
					<button
						type="button"
						onClick={cancelRun}
						disabled={selectedRun?.status !== "running" || cancellingRun}
					>
						{cancellingRun ? "Cancelling…" : "Cancel"}
					</button>
					<ProcessIndicator state={processState} />
				</div>
				{selectedTask ? (
					<div className="run-task-card">
						<strong>Task</strong>
						<TaskLink taskId={selectedTask.id} projectId={selectedTask.projectId}>
							{selectedTask.title}
						</TaskLink>
						<span className={`task-status status-${selectedTask.status}`}>
							{selectedTask.status.replace(/_/g, " ")}
						</span>
					</div>
				) : null}
				<div
					className="run-chat-scroll"
					ref={chatScrollRef}
					onScroll={(e) =>
						persistScroll(`runs-chat-scroll:${runId}`, e.currentTarget)
					}
				>
					{stalledNotice ? (
						<section className="chat-bubble stalled-notice message-warning">
							<strong>Agent activity stalled</strong>
							<MarkdownText
								text={`No agent event for ${stalledNotice.idleFor}. Last event: \`${stalledNotice.lastEventType}\`. Aware is still waiting for the runtime, usually because the model/provider stream is hung or slow. If no activity resumes, this run will be failed automatically in about ${stalledNotice.remaining}.`}
							/>
						</section>
					) : null}
					<ChatTimeline events={selectedEvents} />
					<div ref={bottomRef} />
				</div>
				{selectedRun?.readOnly ? null : (
					<RunInputBar
						initialMessage={initialRunsState.message}
						runId={runId}
						canMarkDone={
							selectedRun?.status === "done" &&
							selectedTask?.status === "need_review"
						}
						markingDone={markingDone}
						sendingMessage={sendingMessage}
						onMarkDone={markSelectedRunDone}
						onSend={sendMessage}
					/>
				)}
			</div>
			</div>
		</section>
	);
}
