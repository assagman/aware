import type { AgentRun, RunEvent } from "@agent-ide/shared";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost } from "../app/api";
import { getSelection, setSelectedRunId } from "../app/selection";

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
		type.includes("response_delta") ||
		type === "result"
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
		type === "system" || type === "turn_end" || type.includes("system_message")
	);
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

function fullToolDetail(value: unknown) {
	if (typeof value === "string") {
		const parsed = asPayload(value);
		return Object.keys(parsed).length ? JSON.stringify(parsed, null, 2) : value;
	}
	return jsonText(value);
}

function isSafeHref(href: string) {
	return /^(https?:|mailto:|\/|#)/i.test(href);
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	let i = 0;
	function pushText(value: string) {
		if (value) nodes.push(value);
	}
	while (i < text.length) {
		const rest = text.slice(i);
		const link = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
		if (link) {
			const full = link[0] ?? "";
			const label = link[1] ?? "";
			const href = link[2] ?? "";
			nodes.push(
				isSafeHref(href) ? (
					<a
						key={`${keyPrefix}-link-${i}`}
						href={href}
						target="_blank"
						rel="noreferrer"
					>
						{renderInline(label, `${keyPrefix}-link-${i}`)}
					</a>
				) : (
					full
				),
			);
			i += full.length;
			continue;
		}
		const codeEnd = text.indexOf("`", i + 1);
		if (text[i] === "`" && codeEnd > i) {
			nodes.push(
				<code key={`${keyPrefix}-code-${i}`}>
					{text.slice(i + 1, codeEnd)}
				</code>,
			);
			i = codeEnd + 1;
			continue;
		}
		if (text.startsWith("**", i)) {
			const end = text.indexOf("**", i + 2);
			if (end > i) {
				nodes.push(
					<strong key={`${keyPrefix}-strong-${i}`}>
						{renderInline(text.slice(i + 2, end), `${keyPrefix}-strong-${i}`)}
					</strong>,
				);
				i = end + 2;
				continue;
			}
		}
		if (text[i] === "*") {
			const end = text.indexOf("*", i + 1);
			if (end > i) {
				nodes.push(
					<em key={`${keyPrefix}-em-${i}`}>
						{renderInline(text.slice(i + 1, end), `${keyPrefix}-em-${i}`)}
					</em>,
				);
				i = end + 1;
				continue;
			}
		}
		const next = [
			text.indexOf("[", i + 1),
			text.indexOf("`", i + 1),
			text.indexOf("**", i + 1),
			text.indexOf("*", i + 1),
		]
			.filter((n) => n !== -1)
			.sort((a, b) => a - b)[0];
		pushText(text.slice(i, next ?? text.length));
		i = next ?? text.length;
	}
	return nodes;
}

function isMarkdownBlockStart(line: string) {
	return (
		/^```/.test(line) ||
		/^#{1,6}\s+/.test(line) ||
		/^>\s?/.test(line) ||
		/^\s*[-*+]\s+/.test(line) ||
		/^\s*\d+[.)]\s+/.test(line)
	);
}

function MarkdownText({
	text,
	className = "",
}: {
	text: string;
	className?: string;
}) {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const blocks: ReactNode[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (!line.trim()) {
			i++;
			continue;
		}
		const fence = line.match(/^```\s*(\S*)/);
		if (fence) {
			const code: string[] = [];
			i++;
			while (i < lines.length && !/^```/.test(lines[i] ?? ""))
				code.push(lines[i++] ?? "");
			if (i < lines.length) i++;
			blocks.push(
				<pre
					key={`code-${i}`}
					className={fence[1] ? `language-${fence[1]}` : undefined}
				>
					<code>{code.join("\n")}</code>
				</pre>,
			);
			continue;
		}
		const heading = line.match(/^(#{1,6})\s+(.+)$/);
		if (heading) {
			const marks = heading[1] ?? "#";
			const Tag = `h${marks.length}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
			blocks.push(
				<Tag key={`h-${i}`}>{renderInline(heading[2] ?? "", `h-${i}`)}</Tag>,
			);
			i++;
			continue;
		}
		if (/^>\s?/.test(line)) {
			const quote: string[] = [];
			while (i < lines.length && /^>\s?/.test(lines[i] ?? ""))
				quote.push((lines[i++] ?? "").replace(/^>\s?/, ""));
			blocks.push(
				<blockquote key={`q-${i}`}>
					{quote.map((q, n) => (
						<p key={n}>{renderInline(q, `q-${i}-${n}`)}</p>
					))}
				</blockquote>,
			);
			continue;
		}
		if (/^\s*[-*+]\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? ""))
				items.push((lines[i++] ?? "").replace(/^\s*[-*+]\s+/, ""));
			blocks.push(
				<ul key={`ul-${i}`}>
					{items.map((item, n) => (
						<li key={n}>{renderInline(item, `ul-${i}-${n}`)}</li>
					))}
				</ul>,
			);
			continue;
		}
		if (/^\s*\d+[.)]\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? ""))
				items.push((lines[i++] ?? "").replace(/^\s*\d+[.)]\s+/, ""));
			blocks.push(
				<ol key={`ol-${i}`}>
					{items.map((item, n) => (
						<li key={n}>{renderInline(item, `ol-${i}-${n}`)}</li>
					))}
				</ol>,
			);
			continue;
		}
		const paragraph: string[] = [];
		while (
			i < lines.length &&
			(lines[i] ?? "").trim() &&
			!isMarkdownBlockStart(lines[i] ?? "")
		)
			paragraph.push(lines[i++] ?? "");
		blocks.push(
			<p key={`p-${i}`}>{renderInline(paragraph.join("\n"), `p-${i}`)}</p>,
		);
	}
	return <div className={`markdown-text ${className}`.trim()}>{blocks}</div>;
}

function activeAgentLabel(run: AgentRun | undefined, _events: RunEvent[]) {
	if (!run) return "—";
	return run.mainAgentName ?? "Main agent";
}

function errorText(payload: unknown) {
	return textOf(payload) || jsonPreview(payload, 4000);
}

function ProcessIndicator({ live }: { live: boolean }) {
	return (
		<span className={`run-process-indicator ${live ? "live" : "idle"}`}>
			<span aria-hidden="true" />
			{live ? "Live" : "Idle"}
		</span>
	);
}

function LatestErrorBox({ event }: { event: RunEvent }) {
	return (
		<section className="chat-bubble error message-error latest-error">
			<strong>Latest error</strong>
			<MarkdownText text={errorText(event.payload)} />
		</section>
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
	if (normalized === "read") return "tool-read";
	if (normalized === "bash") return "tool-bash";
	let hash = 0;
	for (let i = 0; i < name.length; i++)
		hash = (hash * 31 + name.charCodeAt(i)) | 0;
	return toolPalette[Math.abs(hash) % toolPalette.length];
}

function ToolBlock({ start, end }: { start: RunEvent; end?: RunEvent }) {
	const name = toolName(start.payload, "tool");
	const args = toolArgs(start.payload);
	const argsSummary = toolArgsSummary(name, args);
	const failed = end ? toolFailed(end.payload) : false;
	const status = end ? (failed ? "failed" : "success") : "running";
	const normalizedName = name.toLowerCase();
	const isEdit = normalizedName.includes("edit");
	const isWrite = normalizedName.includes("write");
	const showsDiffOnly = isEdit || isWrite;
	const isEditError = isEdit && failed;
	const resultPatch = end ? patchFromPayload(end.payload) : undefined;
	const toolPatch = isEditError
		? undefined
		: (resultPatch ??
			(isEdit ? buildEditPatch(args) : undefined) ??
			(isWrite ? buildWritePatch(args) : undefined));
	return (
		<details
			className={`chat-bubble tool-event tool-${status} ${toolColorClass(name)}`}
			open={!end || showsDiffOnly}
		>
			<summary>
				<strong>{name}</strong>
				{argsSummary ? <> &gt; {argsSummary}</> : null}
			</summary>
			{toolPatch ? <ToolDiff patch={toolPatch} /> : null}
			{isEditError ? (
				<section className="tool-details-grid">
					<div>
						<strong>Error</strong>
						<pre>
							{fullToolDetail(end ? toolOutput(end.payload) : "Edit failed")}
						</pre>
					</div>
				</section>
			) : showsDiffOnly ? null : (
				<section className="tool-details-grid">
					<div>
						<strong>Arguments</strong>
						<pre>{jsonPreview(args, 4000)}</pre>
					</div>
					{end ? (
						<div>
							<strong>Result</strong>
							<pre>{jsonPreview(toolOutput(end.payload), 4000)}</pre>
						</div>
					) : null}
				</section>
			)}
		</details>
	);
}

function ChatTimeline({ events }: { events: RunEvent[] }) {
	const ordered = [...events].sort((a, b) => a.seq - b.seq);
	const toolEnds = new Map<string, RunEvent>();
	for (const event of ordered) {
		if (isToolEndEvent(event)) toolEnds.set(toolKey(event), event);
	}
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
					<MarkdownText text={textOf(event.payload)} />
				</section>,
			);
		} else if (event.type === "annotations") {
			rendered.push(<AnnotationSummary key={event.id} event={event} />);
		} else if (event.type === "prompt") {
			rendered.push(
				<details key={event.id} className="chat-bubble message-prompt">
					<summary>Full prompt</summary>
					<pre>{textOf(event.payload)}</pre>
				</details>,
			);
		} else if (isToolStartEvent(event)) {
			const end = toolEnds.get(toolKey(event));
			rendered.push(
				end ? (
					<ToolBlock key={event.id} start={event} end={end} />
				) : (
					<ToolBlock key={event.id} start={event} />
				),
			);
		} else if (event.type === "result") {
			const text = extractTextDeep(event.payload);
			if (text)
				rendered.push(
					<section
						key={event.id}
						className="chat-bubble assistant-message message-assistant"
					>
						<strong>Assistant</strong>
						<MarkdownText text={text} />
					</section>,
				);
		} else if (event.type === "error") {
			rendered.push(
				<section key={event.id} className="chat-bubble error message-error">
					<strong>Error</strong>
					<MarkdownText text={errorText(event.payload)} />
				</section>,
			);
		} else {
			rendered.push(
				<details key={event.id} className="chat-bubble message-result">
					<summary>{event.type}</summary>
					<pre>{jsonPreview(event.payload, 4000)}</pre>
				</details>,
			);
		}
	}
	flushAssistant();
	flushThinking();
	return <div className="run-chat-timeline">{rendered}</div>;
}

export function RunDetailPage() {
	const [runs, setRuns] = useState<AgentRun[]>([]);
	const [runId, setRunId] = useState(getSelection().selectedRunId);
	const [events, setEvents] = useState<RunEvent[]>([]);
	const [message, setMessage] = useState("");
	const bottomRef = useRef<HTMLDivElement | null>(null);
	const selectedRun = useMemo(
		() => runs.find((r) => r.id === runId),
		[runs, runId],
	);
	const activeAgent = useMemo(
		() => activeAgentLabel(selectedRun, events),
		[selectedRun, events],
	);
	const latestError = useMemo(
		() => [...events].reverse().find((event) => event.type === "error"),
		[events],
	);
	const lastVisibleEvent = useMemo(
		() => [...events].reverse().find((event) => !isHiddenEvent(event)),
		[events],
	);
	async function loadRuns() {
		const rows = await apiGet<AgentRun[]>("/runs");
		setRuns(rows);
		if (!runId && rows[0]) setRunId(rows[0].id);
	}
	async function loadEvents(id = runId) {
		if (!id) return;
		setEvents(await apiGet<RunEvent[]>(`/runs/${id}/events`));
		setSelectedRunId(id);
	}
	useEffect(() => {
		void loadRuns();
		const onSelection = () => {
			const selectedRunId = getSelection().selectedRunId;
			if (selectedRunId) setRunId(selectedRunId);
		};
		window.addEventListener("agent-ide-selection", onSelection);
		return () => window.removeEventListener("agent-ide-selection", onSelection);
	}, []);
	useEffect(() => {
		if (!runId) return;
		void loadEvents(runId);
		const timer = window.setInterval(
			() => {
				void loadRuns();
				void loadEvents(runId);
			},
			selectedRun?.status === "running" ? 750 : 2000,
		);
		return () => window.clearInterval(timer);
	}, [runId, selectedRun?.status]);
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ block: "end" });
	}, [events.length]);
	async function cancelRun() {
		if (!runId) return;
		await apiPost(`/runs/${runId}/cancel`, {});
		await loadRuns();
		await loadEvents(runId);
	}
	async function sendMessage() {
		if (!runId || !message.trim()) return;
		await apiPost(`/runs/${runId}/messages`, { message });
		setMessage("");
		await loadEvents(runId);
	}
	return (
		<section id="runs" className="card run-page">
			<div className="run-header">
				<h2>Run chat</h2>
				<select value={runId} onChange={(e) => setRunId(e.target.value)}>
					<option value="">select run</option>
					{runs.map((r) => (
						<option key={r.id} value={r.id}>
							{r.status} — {new Date(r.startedAt).toLocaleString()} —{" "}
							{r.id.slice(0, 8)}
						</option>
					))}
				</select>
				{selectedRun ? (
					<>
						<span>
							Status: <strong>{selectedRun.status}</strong>
						</span>
						<span>
							Main agent: <strong>{activeAgent}</strong>
						</span>
					</>
				) : null}
				<button
					type="button"
					onClick={cancelRun}
					disabled={selectedRun?.status !== "running"}
				>
					Cancel
				</button>
				<ProcessIndicator live={selectedRun?.status === "running"} />
			</div>
			<div className="run-chat-scroll">
				<ChatTimeline events={events} />
				{latestError && lastVisibleEvent?.id !== latestError.id ? (
					<LatestErrorBox event={latestError} />
				) : null}
				<div ref={bottomRef} />
			</div>
			<div className="run-input-bar">
				<textarea
					value={message}
					onChange={(e) => setMessage(e.target.value)}
					placeholder="Steer this run..."
					onKeyDown={(e) => {
						if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
							e.preventDefault();
							void sendMessage();
						}
					}}
				/>
				<button
					type="button"
					onClick={sendMessage}
					disabled={!message.trim() || !runId}
				>
					Send
				</button>
			</div>
		</section>
	);
}
