import type {
	AgentRun,
	Annotation,
	GraphAction,
	GraphProjection,
	GraphProjectionNode,
	Project,
	RunEvent,
	RunLane,
	RunRelation,
	Task,
	TaskStatus,
	Worktree,
} from "@aware/shared";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import type { OnDiffLineClickProps, SelectedLineRange } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import {
	Background,
	BaseEdge,
	Controls,
	Position,
	ReactFlow,
	useReactFlow,
	type Edge,
	type EdgeProps,
	type Node,
	type NodeMouseHandler,
	type Viewport,
} from "@xyflow/react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { bundledLanguages, codeToHtml } from "shiki";
import { API_BASE, apiDelete, apiGet, apiPatch, apiPost } from "../app/api";
import { getPageState, setPageState } from "../app/pageState";
import { setSelectedRunId, setSelectedTaskId } from "../app/selection";
import { BusyIndicator } from "../components/BusyIndicator";
import { FileTreeView } from "../components/FileTreeView";
import { WorktreePicker } from "../components/WorktreePicker";

type Payload = Record<string, unknown>;
export type WorkspaceViewState = {
	mode: "files" | "diff";
	worktreeId: string;
	title: string;
	subtitle: string;
	projectId?: string;
	taskId?: string;
};

type DialogState =
	| { type: "create-task"; projectId?: string }
	| { type: "task"; taskId: string }
	| {
			type: "new-run";
			taskId: string;
			relation: RunRelation;
			lane?: RunLane;
			parentRunId?: string;
		}
	| { type: "review"; taskId: string }
	| null;
type GraphNodeData = Record<string, unknown> & {
	kind: "project" | "annotation" | "annotation-tasks" | "task" | "run" | "add-task" | "add-run" | "checkpoint" | "ship" | "review";
	label: ReactNode;
	projectId?: string | undefined;
	annotationId?: string | undefined;
	taskId?: string | undefined;
	runId?: string | undefined;
	worktreeId?: string | undefined;
	relation?: RunRelation | undefined;
	lane?: RunLane | undefined;
	parentRunId?: string | undefined;
	href?: string | undefined;
};
type GraphNode = Node<GraphNodeData>;
type GraphViewportState = { viewport?: Viewport; signature?: string; size?: { width: number; height: number } };

type ReviewState = "waiting" | "ready" | "done" | "need_rerun";

const taskStatusOrder: Record<TaskStatus, number> = {
	running: 0,
	need_review: 1,
	queued: 2,
	failed: 3,
	draft: 4,
	done: 5,
};

function labelStatus(status: string) {
	return status.replace(/_/g, " ");
}

function compactId(id: string) {
	return id.slice(0, 8);
}

function firstInstructionLine(value: string | undefined) {
	return value?.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "No run instructions captured";
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

function textOf(payload: unknown) {
	if (!payload || typeof payload !== "object") return "";
	const p = payload as Payload;
	if (typeof p.text === "string") return p.text;
	if (typeof p.delta === "string") return p.delta;
	if (typeof p.message === "string") return p.message;
	if (typeof p.thinking === "string") return p.thinking;
	if (typeof p.reasoning === "string") return p.reasoning;
	if (typeof p.content === "string") return p.content;
	if (p.data && typeof p.data === "object") return textOf(p.data);
	return "";
}

function extractTextDeep(value: unknown): string {
	const direct = textOf(value);
	if (direct) return direct;
	if (Array.isArray(value)) return value.map(extractTextDeep).join("");
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

function eventType(event: RunEvent) {
	return event.type.toLowerCase().replace(/[.:]/g, "_");
}

function isThinkingEvent(event: RunEvent) {
	const type = eventType(event);
	return type.includes("thinking") || type.includes("reason");
}

function isAssistantEvent(event: RunEvent) {
	const type = eventType(event);
	if (isThinkingEvent(event) || type.includes("tool")) return false;
	return (
		type === "text_delta" ||
		type.includes("assistant") ||
		type.includes("message_delta") ||
		type.includes("content_delta") ||
		type.includes("response_delta")
	);
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
		type === "idle"
	);
}

function jsonText(value: unknown, max = 5000) {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);
	return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
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
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function lineRange(args: Payload) {
	const direct = argText(args.range ?? args.lineRange ?? args.lines);
	if (direct) return direct;
	const start = Number(args.startLine ?? args.line ?? args.offset);
	const end = Number(args.endLine);
	const limit = Number(args.limit);
	if (Number.isFinite(start) && Number.isFinite(end)) return `${start}-${end}`;
	if (Number.isFinite(start) && Number.isFinite(limit)) return `${start}-${start + limit - 1}`;
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
	if (normalized.includes("bash") || normalized.includes("shell")) return argText(p.command ?? p.cmd ?? p.script ?? p.input) ?? "";
	if (normalized.includes("read")) return [path, lineRange(p)].filter(Boolean).join(" ");
	if (normalized.includes("edit") || normalized.includes("write")) return path ?? "";
	if (normalized.includes("grep") || normalized.includes("search")) return [argText(p.pattern ?? p.query), path, argText(p.include)].filter(Boolean).join(" ");
	if (normalized.includes("glob") || normalized.includes("find")) return [argText(p.pattern), path].filter(Boolean).join(" ");
	return Object.entries(p)
		.map(([key, value]) => {
			const text = argText(value);
			return text ? `${key}=${text}` : undefined;
		})
		.filter(Boolean)
		.join(" ");
}

function toolColorClass(name: string) {
	const normalized = name.toLowerCase();
	if (normalized.includes("read")) return "tool-read";
	if (normalized.includes("bash") || normalized.includes("shell")) return "tool-bash";
	if (normalized.includes("edit")) return "tool-edit";
	if (normalized.includes("write")) return "tool-write";
	return "tool-custom";
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
	const oldText = firstString(p, ["oldText", "old_text", "oldString", "old_string"]) ?? stringifyArg(p.old);
	const newText = firstString(p, ["newText", "new_text", "newString", "new_string", "replacement"]) ?? stringifyArg(p.new);
	if (!path || oldText === undefined || newText === undefined) return undefined;
	const oldLines = splitPatchLines(oldText);
	const newLines = splitPatchLines(newText);
	return [
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -1,${oldLines.length} +1,${newLines.length} @@`,
		...prefixedPatchLines("-", oldText),
		...prefixedPatchLines("+", newText),
		"",
	].join("\n");
}

function buildWritePatch(args: unknown) {
	const p = asPayload(args);
	const path = firstString(p, ["path", "filePath", "file_path", "filename"]);
	const content = firstString(p, ["content", "text", "data", "newText", "new_text"]) ?? stringifyArg(p.input);
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

function toolOutput(payload: unknown) {
	const p = asPayload(payload);
	return p.result ?? p.output ?? p.error ?? p;
}

function patchFromPayload(value: unknown): string | undefined {
	const direct = firstString(value, ["patch", "diff"]);
	if (direct) return direct;
	return firstString(toolOutput(value), ["patch", "diff"]);
}

function parsePatch(patch: string) {
	try {
		return parsePatchFiles(patch, "tool-edit-diff", false).flatMap((parsed) => parsed.files);
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
				<FileDiff key={`${file.name}-${file.prevName ?? ""}`} fileDiff={file} disableWorkerPool />
			))}
		</div>
	);
}

type DiffSectionId = "committed" | "staged" | "unstaged";
type DiffPatches = Record<DiffSectionId, string>;

const EMPTY_DIFF_PATCHES: DiffPatches = { committed: "", staged: "", unstaged: "" };
const EMPTY_GIT_STATUS: GitStatusEntry[] = [];

function parseDiffFilesForView(patch: string) {
	try {
		return parsePatchFiles(patch, "home-workspace-diff", false).flatMap((parsed) => parsed.files);
	} catch {
		return [];
	}
}

function fallbackDiffFiles(patch: string) {
	return [...patch.matchAll(/^diff --git a\/(.*?) b\//gm)].map((match) => match[1] ?? "").filter(Boolean);
}

function diffStatus(type: string): GitStatus {
	if (type === "new") return "added";
	if (type === "deleted") return "deleted";
	if (type === "rename-pure" || type === "rename-changed") return "renamed";
	return "modified";
}

const gitStatusWeight: Record<GitStatus, number> = {
	ignored: 0,
	modified: 1,
	renamed: 2,
	untracked: 3,
	added: 4,
	deleted: 5,
};

function setWeightedStatus(map: Map<string, GitStatus>, path: string | undefined, status: GitStatus) {
	if (!path) return;
	const current = map.get(path);
	if (!current || gitStatusWeight[status] >= gitStatusWeight[current]) map.set(path, status);
}

function diffSectionsFromPatches(patches: DiffPatches) {
	return [
		{
			id: "committed" as const,
			title: "Committed (main..HEAD)",
			patch: patches.committed,
			files: parseDiffFilesForView(patches.committed),
			fallbackFiles: fallbackDiffFiles(patches.committed),
		},
		{
			id: "staged" as const,
			title: "Staged",
			patch: patches.staged,
			files: parseDiffFilesForView(patches.staged),
			fallbackFiles: fallbackDiffFiles(patches.staged),
		},
		{
			id: "unstaged" as const,
			title: "Unstaged",
			patch: patches.unstaged,
			files: parseDiffFilesForView(patches.unstaged),
			fallbackFiles: fallbackDiffFiles(patches.unstaged),
		},
	];
}

function diffGitStatusEntries(sections: ReturnType<typeof diffSectionsFromPatches>): GitStatusEntry[] {
	const byPath = new Map<string, GitStatus>();
	for (const section of sections) {
		for (const file of section.files) {
			const status = diffStatus(file.type);
			setWeightedStatus(byPath, file.name, status);
			if (file.prevName && file.prevName !== file.name) setWeightedStatus(byPath, file.prevName, "renamed");
		}
		for (const path of section.fallbackFiles) setWeightedStatus(byPath, path, "modified");
	}
	return [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, status]) => ({ path, status }));
}

function pickInitialFile(paths: string[], saved: string) {
	if (saved && paths.includes(saved)) return saved;
	return paths.find((path) => /(^|\/)readme(\.[^.]+)?$/i.test(path)) ?? paths[0] ?? "";
}

function basename(path: string) {
	return path.split("/").at(-1) || path;
}

const languageByFilename: Record<string, string> = {
	"dockerfile": "docker",
	"makefile": "make",
	"cmakelists.txt": "cmake",
	"package.json": "json",
	"tsconfig.json": "jsonc",
	"vite.config.ts": "typescript",
	"pnpm-lock.yaml": "yaml",
};

const languageByExtension: Record<string, string> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	jsonc: "jsonc",
	md: "markdown",
	mdx: "mdx",
	css: "css",
	scss: "scss",
	sass: "sass",
	less: "less",
	html: "html",
	xml: "xml",
	yml: "yaml",
	yaml: "yaml",
	sh: "shellscript",
	bash: "shellscript",
	zsh: "shellscript",
	fish: "fish",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	swift: "swift",
	sql: "sql",
	toml: "toml",
	ini: "ini",
	env: "dotenv",
	diff: "diff",
	patch: "diff",
};

function fileLanguage(path: string) {
	const name = basename(path).toLowerCase();
	if (languageByFilename[name]) return languageByFilename[name];
	const extension = name.split(".").at(-1) ?? "";
	return languageByExtension[extension] ?? "text";
}

async function highlightedFileHtml(path: string, content: string) {
	const languages = bundledLanguages as Record<string, unknown>;
	const preferred = fileLanguage(path);
	const lang = preferred in languages ? preferred : "text";
	const html = await codeToHtml(content || " ", {
		lang,
		theme: "vitesse-dark",
	});
	return html.replaceAll('</span>\n<span class="line">', '</span><span class="line">');
}

function decorateHighlightedFileHtml(html: string, selectedStart?: number, selectedEnd?: number) {
	if (!html) return html;
	let line = 0;
	return html.replace(/<span class="line"/g, () => {
		line += 1;
		const selected = selectedStart && selectedEnd && line >= selectedStart && line <= selectedEnd;
		return `<span class="line${selected ? " selected" : ""}" data-line="${line}"`;
	});
}

function normalizedLineRange(start: number, end: number) {
	return { start: Math.min(start, end), end: Math.max(start, end) };
}

function annotationRangeLabel(path: string, startLine?: number, endLine?: number) {
	if (!startLine) return path;
	return endLine && endLine !== startLine ? `${path}:${startLine}-${endLine}` : `${path}:${startLine}`;
}

function annotationContext(path: string, startLine: number, endLine: number, text: string) {
	return `${annotationRangeLabel(path, startLine, endLine)}\n${text}`;
}

type PendingAnnotation = {
	kind: Annotation["kind"];
	filePath: string;
	side?: Annotation["side"];
	startLine: number;
	endLine: number;
	selectedText: string;
	context: string;
	x: number;
	y: number;
};

function annotationPopoverStyle(annotation: PendingAnnotation, editing: boolean): CSSProperties {
	const width = Math.min(420, Math.max(260, window.innerWidth - 28));
	const estimatedHeight = editing ? 196 : 58;
	const left = Math.min(window.innerWidth - 14 - width / 2, Math.max(14 + width / 2, annotation.x));
	const top = Math.min(window.innerHeight - estimatedHeight - 14, Math.max(84, annotation.y + 30));
	return { left, top };
}

function closestLineElement(node: globalThis.Node | null, root: HTMLElement) {
	let current: globalThis.Node | null = node;
	while (current && current !== root) {
		if (current instanceof HTMLElement && (current.matches(".home-code-highlight .line") || current.matches(".home-code-line"))) return current;
		current = current.parentNode;
	}
	return null;
}

function lineNumberForElement(element: HTMLElement, root: HTMLElement) {
	const explicit = Number(element.dataset.line);
	if (Number.isFinite(explicit) && explicit > 0) return explicit;
	const highlighted = [...root.querySelectorAll<HTMLElement>(".home-code-highlight .line")];
	const highlightedIndex = highlighted.indexOf(element);
	if (highlightedIndex >= 0) return highlightedIndex + 1;
	const fallback = [...root.querySelectorAll<HTMLElement>(".home-code-line")];
	const fallbackIndex = fallback.indexOf(element);
	return fallbackIndex >= 0 ? fallbackIndex + 1 : undefined;
}

function pendingFileTextSelection(root: HTMLElement, filePath: string, lines: string[]): PendingAnnotation | undefined {
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed || !selection.rangeCount) return undefined;
	const range = selection.getRangeAt(0);
	if (!root.contains(range.commonAncestorContainer)) return undefined;
	const startElement = closestLineElement(range.startContainer, root);
	const endElement = closestLineElement(range.endContainer, root);
	if (!startElement || !endElement) return undefined;
	const start = lineNumberForElement(startElement, root);
	const end = lineNumberForElement(endElement, root);
	if (!start || !end) return undefined;
	const normalized = normalizedLineRange(start, end);
	const selectedText = selection.toString();
	if (!selectedText.trim()) return undefined;
	const rect = range.getBoundingClientRect();
	const exactLines = lines.slice(normalized.start - 1, normalized.end).join("\n");
	return {
		kind: normalized.start === normalized.end ? "line" : "range",
		filePath,
		startLine: normalized.start,
		endLine: normalized.end,
		selectedText,
		context: annotationContext(filePath, normalized.start, normalized.end, exactLines || selectedText),
		x: rect.left + rect.width / 2,
		y: rect.top,
	};
}

function pendingFileLineSelection(filePath: string, lines: string[], start: number, end: number, rect: DOMRect): PendingAnnotation {
	const normalized = normalizedLineRange(start, end);
	const selectedText = lines.slice(normalized.start - 1, normalized.end).join("\n");
	return {
		kind: normalized.start === normalized.end ? "line" : "range",
		filePath,
		startLine: normalized.start,
		endLine: normalized.end,
		selectedText,
		context: annotationContext(filePath, normalized.start, normalized.end, selectedText),
		x: rect.left + rect.width / 2,
		y: rect.top,
	};
}

function patchForFile(patch: string, filePath: string) {
	const chunks = patch.split(/^diff --git /m);
	for (const chunk of chunks) {
		if (!chunk.trim()) continue;
		const full = `diff --git ${chunk}`;
		const header = full.split("\n", 1)[0] ?? "";
		if (header.includes(` b/${filePath}`) || header.includes(` a/${filePath}`)) return full;
	}
	return "";
}

function diffSelectedText(patch: string, filePath: string, side: Annotation["side"], startLine: number, endLine: number) {
	const filePatch = patchForFile(patch, filePath);
	if (!filePatch) return "";
	const selected: string[] = [];
	let oldLine = 0;
	let newLine = 0;
	for (const raw of filePatch.split(/\r?\n/)) {
		const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			continue;
		}
		if (!raw || raw.startsWith("diff --git") || raw.startsWith("+++") || raw.startsWith("---")) continue;
		const prefix = raw[0];
		const text = raw.slice(1);
		const useOld = side === "old" || side === "deletions";
		if (prefix === " ") {
			const line = useOld ? oldLine : newLine;
			if (line >= startLine && line <= endLine) selected.push(text);
			oldLine += 1;
			newLine += 1;
		} else if (prefix === "-") {
			if (useOld && oldLine >= startLine && oldLine <= endLine) selected.push(text);
			oldLine += 1;
		} else if (prefix === "+") {
			if (!useOld && newLine >= startLine && newLine <= endLine) selected.push(text);
			newLine += 1;
		}
	}
	return selected.join("\n");
}

export function HomeWorkspaceView({ view, onBack, onGraph, onWorktreeChange, onModeChange, initialFile = "", onFileChange }: { view: WorkspaceViewState; onBack: () => void; onGraph?: () => void; onWorktreeChange?: (worktreeId: string) => void; onModeChange?: (mode: WorkspaceViewState["mode"]) => void; initialFile?: string; onFileChange?: (path: string) => void }) {
	const stateKey = `home-workspace:${view.mode}:${view.worktreeId}`;
	const initial = { file: initialFile || getPageState(stateKey, { file: "" }).file };
	const [paths, setPaths] = useState<string[]>([]);
	const [file, setFile] = useState(initial.file);
	const fileRef = useRef(initial.file);
	const fileLoadSeqRef = useRef(0);
	const highlightSeqRef = useRef(0);
	const [content, setContent] = useState("");
	const [contentPath, setContentPath] = useState("");
	const [contentVersion, setContentVersion] = useState(0);
	const [treeLoading, setTreeLoading] = useState(false);
	const [fileLoading, setFileLoading] = useState(false);
	const [diffLoading, setDiffLoading] = useState(false);
	const [error, setError] = useState("");
	const [diffPatches, setDiffPatches] = useState<DiffPatches>(EMPTY_DIFF_PATCHES);
	const [highlightedHtml, setHighlightedHtml] = useState("");
	const [syntaxLoading, setSyntaxLoading] = useState(false);
	const [pendingAnnotation, setPendingAnnotation] = useState<PendingAnnotation | null>(null);
	const [annotationEditing, setAnnotationEditing] = useState(false);
	const [annotationNote, setAnnotationNote] = useState("");
	const [annotationSaving, setAnnotationSaving] = useState(false);
	const [lineSelection, setLineSelection] = useState<{ start: number; end: number } | null>(null);
	const [diffSelection, setDiffSelection] = useState<(SelectedLineRange & { filePath: string; patch: string }) | null>(null);
	const codeRootRef = useRef<HTMLDivElement | null>(null);
	const onFileChangeRef = useRef(onFileChange);
	useEffect(() => {
		onFileChangeRef.current = onFileChange;
	}, [onFileChange]);
	useEffect(() => {
		fileRef.current = file;
	}, [file]);
	const visibleContent = contentPath === file ? content : "";
	const lines = useMemo(() => visibleContent.split("\n"), [visibleContent]);
	const diffSections = useMemo(() => diffSectionsFromPatches(diffPatches), [diffPatches]);
	const gitStatus = useMemo(() => diffGitStatusEntries(diffSections), [diffSections]);
	const changedPaths = useMemo(() => gitStatus.map((entry) => entry.path), [gitStatus]);
	const hasDiff = diffSections.some((section) => section.patch.trim());
	const renderedHighlightedHtml = useMemo(
		() => decorateHighlightedFileHtml(highlightedHtml, lineSelection?.start, lineSelection?.end),
		[highlightedHtml, lineSelection?.end, lineSelection?.start],
	);

	const readFile = useCallback(async (path: string) => {
		if (!path) return;
		const loadSeq = ++fileLoadSeqRef.current;
		const sameFile = fileRef.current === path;
		fileRef.current = path;
		setFile(path);
		onFileChangeRef.current?.(path);
		setPageState(stateKey, { file: path });
		if (view.mode === "diff") return;
		if (!sameFile) {
			setContent("");
			setContentPath("");
			setHighlightedHtml("");
			setPendingAnnotation(null);
			setAnnotationEditing(false);
			setAnnotationNote("");
			setLineSelection(null);
			setDiffSelection(null);
		}
		setFileLoading(true);
		try {
			const response = await fetch(view.projectId ? `${API_BASE}/projects/${encodeURIComponent(view.projectId)}/worktrees/${encodeURIComponent(view.worktreeId)}/files/content?${new URLSearchParams({ path })}` : `${API_BASE}/files/read?${new URLSearchParams({ worktreeId: view.worktreeId, path })}`);
			if (!response.ok) throw new Error(await response.text());
			const nextContent = await response.text();
			if (loadSeq !== fileLoadSeqRef.current || fileRef.current !== path) return;
			setContent(nextContent);
			setContentPath(path);
			setContentVersion((version) => version + 1);
			setError("");
		} catch (nextError) {
			if (loadSeq !== fileLoadSeqRef.current || fileRef.current !== path) return;
			setContent("");
			setContentPath("");
			setHighlightedHtml("");
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			if (loadSeq === fileLoadSeqRef.current && fileRef.current === path) setFileLoading(false);
		}
	}, [stateKey, view.mode, view.projectId, view.worktreeId]);

	const loadTree = useCallback(async () => {
		if (view.mode !== "files") {
			setPaths([]);
			return;
		}
		setTreeLoading(true);
		try {
			const nextPaths = await apiGet<string[]>(view.projectId ? `/projects/${encodeURIComponent(view.projectId)}/worktrees/${encodeURIComponent(view.worktreeId)}/files` : `/files/tree?${new URLSearchParams({ worktreeId: view.worktreeId })}`);
			setPaths(nextPaths);
			const saved = initialFile || getPageState(stateKey, { file: "" }).file;
			const nextFile = pickInitialFile(nextPaths, saved);
			if (nextFile) {
				await readFile(nextFile);
				return;
			}
			setError("");
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setTreeLoading(false);
		}
	}, [initialFile, readFile, stateKey, view.mode, view.projectId, view.worktreeId]);

	const loadDiffs = useCallback(async () => {
		if (view.mode !== "diff") return;
		setDiffLoading(true);
		try {
			const fetchPatch = (mode: "main" | "staged" | "unstaged") =>
				fetch(view.projectId ? `${API_BASE}/projects/${encodeURIComponent(view.projectId)}/worktrees/${encodeURIComponent(view.worktreeId)}/diffs?${new URLSearchParams({ mode })}` : `${API_BASE}/diffs/git?${new URLSearchParams({ worktreeId: view.worktreeId, mode })}`).then((response) => response.text());
			const [committed, staged, unstaged] = await Promise.all([
				fetchPatch("main"),
				fetchPatch("staged"),
				fetchPatch("unstaged"),
			]);
			const nextPatches = { committed, staged, unstaged };
			setDiffPatches(nextPatches);
			const nextEntries = diffGitStatusEntries(diffSectionsFromPatches(nextPatches));
			const selected = fileRef.current || getPageState(stateKey, { file: "" }).file;
			if (selected && !nextEntries.some((entry) => entry.path === selected)) {
				fileRef.current = "";
				setFile("");
				onFileChangeRef.current?.("");
				setPageState(stateKey, { file: "" });
			} else if (selected) {
				setPageState(stateKey, { file: selected });
			}
			setError("");
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setDiffLoading(false);
		}
	}, [stateKey, view.mode, view.projectId, view.worktreeId]);

	useEffect(() => { void loadTree(); void loadDiffs(); }, [loadDiffs, loadTree]);
	useEffect(() => {
		if (!initialFile) {
			if (view.mode === "diff" && fileRef.current) {
				fileRef.current = "";
				setFile("");
			}
			return;
		}
		if (initialFile === fileRef.current) return;
		if (view.mode === "files") void readFile(initialFile);
		else {
			fileRef.current = initialFile;
			setFile(initialFile);
			setPageState(stateKey, { file: initialFile });
		}
	}, [initialFile, readFile, stateKey, view.mode]);
	useEffect(() => {
		if (view.mode !== "files" || !file || contentPath !== file) {
			if (view.mode !== "files" || !file) setHighlightedHtml("");
			setSyntaxLoading(false);
			return;
		}
		let cancelled = false;
		const highlightSeq = ++highlightSeqRef.current;
		setSyntaxLoading(true);
		highlightedFileHtml(file, visibleContent)
			.then((html) => {
				if (!cancelled && highlightSeq === highlightSeqRef.current && fileRef.current === file) setHighlightedHtml(html);
			})
			.catch(() => {
				if (!cancelled && highlightSeq === highlightSeqRef.current && fileRef.current === file) setHighlightedHtml("");
			})
			.finally(() => {
				if (!cancelled && highlightSeq === highlightSeqRef.current) setSyntaxLoading(false);
			});
		return () => { cancelled = true; };
	}, [contentPath, contentVersion, file, view.mode, visibleContent]);
	useEffect(() => {
		const source = new EventSource(`${API_BASE}/events/worktrees?${new URLSearchParams({ worktreeId: view.worktreeId })}`);
		const refresh = () => { void loadTree(); void loadDiffs(); };
		source.addEventListener("files", refresh as EventListener);
		source.addEventListener("worktrees", refresh as EventListener);
		source.onerror = () => source.close();
		return () => source.close();
	}, [loadDiffs, loadTree, view.worktreeId]);

	function clearPendingAnnotation() {
		setPendingAnnotation(null);
		setAnnotationEditing(false);
		setAnnotationNote("");
		setDiffSelection(null);
	}

	function handleCodeMouseUp() {
		window.setTimeout(() => {
			if (view.mode !== "files" || !file || !codeRootRef.current) return;
			const pending = pendingFileTextSelection(codeRootRef.current, file, lines);
			if (!pending) return;
			setPendingAnnotation(pending);
			setAnnotationEditing(false);
			setAnnotationNote("");
			setLineSelection(null);
		}, 0);
	}

	function handleCodeClick(event: ReactMouseEvent<HTMLDivElement>) {
		if (view.mode !== "files" || !file || !codeRootRef.current) return;
		const target = event.target instanceof HTMLElement ? event.target : undefined;
		const lineElement = target?.closest<HTMLElement>(".home-code-highlight .line, .home-code-line");
		if (!lineElement || !codeRootRef.current.contains(lineElement)) return;
		const rect = lineElement.getBoundingClientRect();
		if (event.clientX > rect.left + 72) return;
		const line = lineNumberForElement(lineElement, codeRootRef.current);
		if (!line) return;
		const start = event.shiftKey && lineSelection ? lineSelection.start : line;
		const normalized = normalizedLineRange(start, line);
		setLineSelection(normalized);
		setPendingAnnotation(pendingFileLineSelection(file, lines, normalized.start, normalized.end, rect));
		setAnnotationEditing(false);
		setAnnotationNote("");
		window.getSelection()?.removeAllRanges();
	}

	function selectDiffLines(filePath: string, patch: string, range: SelectedLineRange | null) {
		if (!range) {
			setDiffSelection(null);
			clearPendingAnnotation();
			return;
		}
		const start = Math.min(range.start, range.end);
		const end = Math.max(range.start, range.end);
		const rangeSide = String(range.side);
		const side = rangeSide === "deletions" || rangeSide === "old" ? "deletions" : "additions";
		const text = diffSelectedText(patch, filePath, side, start, end);
		setDiffSelection({ ...range, filePath, patch });
		setPendingAnnotation({
			kind: "diff",
			filePath,
			side,
			startLine: start,
			endLine: end,
			selectedText: text,
			context: annotationContext(filePath, start, end, text),
			x: window.innerWidth / 2,
			y: 128,
		});
		setAnnotationEditing(false);
		setAnnotationNote("");
	}

	function selectDiffLine(filePath: string, patch: string, line: OnDiffLineClickProps) {
		selectDiffLines(filePath, patch, {
			start: line.lineNumber,
			end: line.lineNumber,
			side: line.annotationSide,
			endSide: line.annotationSide,
		});
	}

	async function savePendingAnnotation() {
		if (!view.projectId || !pendingAnnotation || !annotationNote.trim() || annotationSaving) return;
		setAnnotationSaving(true);
		try {
			await apiPost<Annotation>(`/projects/${encodeURIComponent(view.projectId)}/annotations`, {
				worktreeId: view.worktreeId,
				kind: pendingAnnotation.kind,
				filePath: pendingAnnotation.filePath,
				...(pendingAnnotation.side ? { side: pendingAnnotation.side } : {}),
				startLine: pendingAnnotation.startLine,
				endLine: pendingAnnotation.endLine,
				text: annotationNote.trim(),
				selectedText: pendingAnnotation.selectedText,
				context: pendingAnnotation.context,
			});
			clearPendingAnnotation();
			setLineSelection(null);
		} finally {
			setAnnotationSaving(false);
		}
	}

	function refresh() {
		void loadTree();
		void loadDiffs();
	}

	return (
		<section className="home-workspace-fullscreen">
			<header className="home-run-topbar home-workspace-topbar">
				<div className="workspace-nav-actions">
					<button type="button" className="back-button" onClick={onBack}>← Back</button>
					{onGraph ? <button type="button" className="back-button" onClick={onGraph}>Graph</button> : null}
				</div>
				<div className="home-run-title">
					<small>{view.mode === "diff" ? "Diff view" : "File view"} · {view.subtitle}</small>
					<h2>{view.title}</h2>
				</div>
				<div className="home-run-topbar-actions">
					{view.mode === "files" && view.projectId && onWorktreeChange ? (
						<WorktreePicker projectId={view.projectId} value={view.worktreeId} onChange={onWorktreeChange} showAdd={false} />
					) : null}
					{onModeChange ? <button type="button" onClick={() => onModeChange(view.mode === "diff" ? "files" : "diff")}>{view.mode === "diff" ? "Files" : "Diffs"}</button> : null}
					{view.projectId ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(view.projectId)}/annotations?${new URLSearchParams({ worktreeId: view.worktreeId })}`}>Annotations</Link> : null}
					{treeLoading || fileLoading || diffLoading || syntaxLoading ? <BusyIndicator label="Loading" /> : null}
					{view.mode === "diff" && file ? <button type="button" onClick={() => { fileRef.current = ""; setFile(""); onFileChangeRef.current?.(""); setPageState(stateKey, { file: "" }); }}>Show all changes</button> : null}
					<button type="button" onClick={refresh}>Refresh</button>
				</div>
			</header>
			<div className="home-workspace-body">
				<aside className="home-workspace-tree card">
					{view.mode === "diff" ? (
						<>
							<div className="panel-head">
								<div>
									<h2>Changed files</h2>
									<small>{changedPaths.length} changed</small>
								</div>
							</div>
							<DiffTreeLegend />
							{changedPaths.length ? (
								<FileTreeView
									hostId="home-diff-changed-tree"
									stateKey="home-diff-changed-tree"
									paths={changedPaths}
									selectedPath={file}
									gitStatus={gitStatus}
									onOpen={(path) => void readFile(path)}
								/>
							) : <p className="home-workspace-empty">No changed files.</p>}
						</>
					) : (
						<>
							<div className="panel-head">
								<div>
									<h2>File tree</h2>
									<small>{paths.length} file{paths.length === 1 ? "" : "s"}</small>
								</div>
							</div>
							{paths.length ? (
								<FileTreeView
									hostId="home-files-tree"
									stateKey="home-files-tree"
									paths={paths}
									selectedPath={file}
									gitStatus={EMPTY_GIT_STATUS}
									onOpen={(path) => void readFile(path)}
								/>
							) : <p className="home-workspace-empty">No files.</p>}
						</>
					)}
				</aside>
				<section className="home-workspace-view card">
					<div className="panel-head home-workspace-view-head">
						<div>
							<h2>{view.mode === "diff" ? (file ? `Diff: ${file}` : "All changes") : (file || "Open file")}</h2>
							{file ? <small>{basename(file)}</small> : null}
						</div>
					</div>
					{error ? <p className="error home-error">{error}</p> : null}
					{pendingAnnotation ? (
						<div className={`annotation-utility-popover${annotationEditing ? " editing" : " compact"}`} style={annotationPopoverStyle(pendingAnnotation, annotationEditing)}>
							<div className="annotation-utility-row">
								<strong>{annotationRangeLabel(pendingAnnotation.filePath, pendingAnnotation.startLine, pendingAnnotation.endLine)}</strong>
								{annotationEditing ? <button type="button" onClick={clearPendingAnnotation}>×</button> : <button type="button" onClick={() => setAnnotationEditing(true)}>Annotate</button>}
							</div>
							{annotationEditing ? (
								<>
									<textarea value={annotationNote} onChange={(event) => setAnnotationNote(event.target.value)} placeholder="Annotation note…" autoFocus onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void savePendingAnnotation(); } }} />
									<div className="annotation-utility-row">
										<small>{pendingAnnotation.kind}{pendingAnnotation.side ? ` · ${pendingAnnotation.side}` : ""}</small>
										<button type="button" disabled={!annotationNote.trim() || annotationSaving} onClick={() => void savePendingAnnotation()}>{annotationSaving ? "Saving…" : "Save"}</button>
									</div>
								</>
							) : null}
						</div>
					) : null}
					{view.mode === "files" ? (
						file ? (
							<div className="home-code-shell" ref={codeRootRef} onMouseUp={handleCodeMouseUp} onClick={handleCodeClick}>
								{highlightedHtml ? (
									<div className="home-code-highlight" dangerouslySetInnerHTML={{ __html: renderedHighlightedHtml }} />
								) : (
									<div className="code-lines home-code-lines">
										{lines.map((line, index) => {
											const n = index + 1;
											const selected = lineSelection && n >= lineSelection.start && n <= lineSelection.end;
											return <div key={`${file}-${index}`} data-line={n} className={`code-line home-code-line${selected ? " selected" : ""}`}><span className="line-no">{n}</span><code>{line || " "}</code></div>;
										})}
									</div>
								)}
							</div>
						) : <p className="home-workspace-empty">Open file from tree.</p>
					) : (
						<div className="files-diff-view home-diff-view">
							{diffLoading ? <BusyIndicator label="Loading diffs" /> : null}
							<div className="files-diff-scroll home-diff-scroll">
								{hasDiff ? diffSections.map((section) => {
									const visibleFiles = file ? section.files.filter((diffFile) => diffFile.name === file || diffFile.prevName === file) : section.files;
									return (
										<section key={section.id} className={`diff-section home-diff-section diff-section-${section.id}`}>
											<h3>{section.title}</h3>
											{visibleFiles.length ? visibleFiles.map((diffFile) => (
												<FileDiff
													key={`${section.id}-${diffFile.name}-${diffFile.prevName ?? ""}`}
													fileDiff={diffFile}
													disableWorkerPool
													selectedLines={diffSelection?.filePath === diffFile.name ? diffSelection : null}
													options={{
														enableLineSelection: true,
														onLineClick: (line) => selectDiffLine(diffFile.name, section.patch, line),
														onLineNumberClick: (line) => selectDiffLine(diffFile.name, section.patch, line),
														onLineSelectionEnd: (range) => selectDiffLines(diffFile.name, section.patch, range),
													}}
												/>
											)) : <p className="empty-state">{section.patch ? (file ? "No changes for selected file in this section." : "No parsed file changes.") : "No changes."}</p>}
										</section>
									);
								}) : <p className="home-workspace-empty">No diff loaded.</p>}
							</div>
						</div>
					)}
				</section>
			</div>
		</section>
	);
}

function DiffTreeLegend() {
	return (
		<div className="home-diff-legend" aria-label="Diff legend">
			<span className="git-added">A</span>
			<span className="git-modified">M</span>
			<span className="git-renamed">R</span>
			<span className="git-deleted">D</span>
		</div>
	);
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
					<pre>{jsonText(item)}</pre>
				</div>
			))}
		</div>
	);
}

function ToolArgumentsView({ name, args, patch }: { name: string; args: unknown; patch?: string | undefined }) {
	const normalized = name.toLowerCase();
	const p = asPayload(args);
	if (isShellTool(name)) return <pre className="tool-command-detail">{argText(p.command ?? p.cmd ?? p.script ?? p.input) ?? jsonText(args)}</pre>;
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
	const p = asPayload(payload);
	return Boolean(p.error || p.isError || p.failed || p.exitCode);
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

export function MarkdownText({ text, className = "" }: { text: string; className?: string }) {
	return (
		<div className={`markdown-text ${className}`.trim()}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[rehypeSanitize]}
				components={markdownComponents}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}

function worktreeName(worktree: Worktree | undefined) {
	if (!worktree) return "?";
	return worktree.path.split("/").filter(Boolean).at(-1) || worktree.path;
}

function activeRuns(runs: AgentRun[]) {
	return runs.filter((run) => !run.deletedAt);
}

function reviewState(task: Task, runs: AgentRun[]): ReviewState {
	const active = activeRuns(runs);
	const allDone = active.length > 0 && active.every((run) => run.status === "done");
	if (task.status === "done" && allDone) return "done";
	if (task.reviewInvalidatedAt && !allDone) return "need_rerun";
	if (task.status === "done") return "need_rerun";
	if (!active.length) return "waiting";
	if (allDone) return "ready";
	return "waiting";
}

function NodeCard({
	eyebrow,
	title,
	status,
	meta,
	accent,
	actions,
}: {
	eyebrow: string;
	title: string;
	status?: string | undefined;
	meta?: ReactNode | undefined;
	accent?: string | undefined;
	actions?: ReactNode | undefined;
}) {
	const classes = ["home-node-card", accent, status ? `status-card-${status}` : "", actions ? "has-actions" : ""]
		.filter(Boolean)
		.join(" ");
	return (
		<div className={classes}>
			{actions ? <div className="run-node-actions">{actions}</div> : null}
			<small>{eyebrow}</small>
			<strong>{title}</strong>
			{status ? (
				<span className={`task-status status-${status}`}>{labelStatus(status)}</span>
			) : null}
			{meta ? <p>{meta}</p> : null}
		</div>
	);
}

function AddRunNodeCard({ label }: { label: string }) {
	return (
		<div className="home-add-run-card" title={label} aria-label={label}>
			<span className="home-add-run-plus" aria-hidden="true">+</span>
		</div>
	);
}

function NodeQuickActions({ actions, onNavigate }: { actions: GraphAction[]; onNavigate: (href: string) => void }) {
	const quick = actions.filter((item) => item.href && ["open_files", "open_diffs", "open_checkpoint", "open_ship", "open_annotations", "open_annotation_tasks"].includes(item.command));
	if (!quick.length) return null;
	return (
		<span className="node-quick-actions">
			{quick.map((item) => (
				<button
					key={item.id}
					type="button"
					onClick={(event) => {
						event.stopPropagation();
						if (item.href) onNavigate(item.href);
					}}
				>
					{item.label.replace(/^Open\s+/i, "")}
				</button>
			))}
		</span>
	);
}

function TaskNodeActions({
	actions,
	onNavigate,
	onArchiveTask,
	archiving,
}: {
	actions: GraphAction[];
	onNavigate: (href: string) => void;
	onArchiveTask?: (() => void) | undefined;
	archiving?: boolean | undefined;
}) {
	const archiveAction = actions.find((item) => item.command === "archive_task");
	return (
		<span
			className="task-node-action-group"
			onClick={(event) => event.stopPropagation()}
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => event.stopPropagation()}
		>
			<NodeQuickActions actions={actions} onNavigate={onNavigate} />
			{archiveAction ? (
				<button
					type="button"
					className="task-node-archive-button"
					title="Archive task and cleanup task worktree/local branch"
					aria-label="Archive task"
					disabled={archiving || !onArchiveTask}
					onClick={(event) => {
						event.stopPropagation();
						onArchiveTask?.();
					}}
				>
					🗄
				</button>
			) : null}
		</span>
	);
}

function RunNodeActions({
	run,
	busy,
	onContinueRun,
	onRetryRun,
	onDeleteRun,
}: {
	run: AgentRun;
	busy: boolean;
	onContinueRun?: ((runId: string) => void) | undefined;
	onRetryRun?: ((runId: string) => void) | undefined;
	onDeleteRun?: ((runId: string) => void) | undefined;
}) {
	const isDeleted = Boolean(run.deletedAt);
	const canContinue = !isDeleted && (run.status === "failed" || run.status === "cancelled");
	const canRetry = !isDeleted && run.status !== "running" && run.status !== "queued";
	const canDelete = !isDeleted && run.status !== "running" && run.status !== "queued";
	return (
		<span
			className="run-node-action-group"
			onClick={(event) => event.stopPropagation()}
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => event.stopPropagation()}
		>
			<button
				type="button"
				title="Retry from original request"
				aria-label="Retry run from original request"
				disabled={!canRetry || busy || !onRetryRun}
				onClick={(event) => {
					event.stopPropagation();
					onRetryRun?.(run.id);
				}}
			>
				↻
			</button>
			<button
				type="button"
				title="Continue stopped run"
				aria-label="Continue stopped run"
				disabled={!canContinue || busy || !onContinueRun}
				onClick={(event) => {
					event.stopPropagation();
					onContinueRun?.(run.id);
				}}
			>
				▶
			</button>
			<button
				type="button"
				title="Trash run"
				aria-label="Trash run"
				disabled={!canDelete || busy || !onDeleteRun}
				onClick={(event) => {
					event.stopPropagation();
					onDeleteRun?.(run.id);
				}}
			>
				🗑
			</button>
		</span>
	);
}

function buildRunLayout(runs: AgentRun[]) {
	const sorted = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	const byId = new Map(sorted.map((run) => [run.id, run]));
	const positions = new Map<string, { depth: number; lane: number }>();
	const occupied = new Set<string>();
	let nextLane = 0;
	for (const run of sorted) {
		const parent = run.parentRunId ? byId.get(run.parentRunId) : undefined;
		const parentPosition = parent ? positions.get(parent.id) : undefined;
		let depth = parentPosition ? parentPosition.depth + 1 : 0;
		let lane = run.relation === "sequential" && parentPosition ? parentPosition.lane : nextLane++;
		while (occupied.has(`${depth}:${lane}`)) lane = nextLane++;
		occupied.add(`${depth}:${lane}`);
		positions.set(run.id, { depth, lane });
	}
	return { sorted, positions, laneCount: Math.max(nextLane, 1) };
}

const GRAPH_X = {
	project: 36,
	task: 390,
	run: 760,
	review: 1120,
};
const GRAPH_ROW_START_Y = 72;
const GRAPH_ROW_GAP = 112;
const GRAPH_RUN_LANE_GAP = 220;
const GRAPH_RUN_DEPTH_GAP = 340;
const GRAPH_RUN_NODE_WIDTH = 240;
const GRAPH_RUN_NODE_HEIGHT = 116;
const GRAPH_ADD_RUN_NODE_HEIGHT = 58;
const GRAPH_ADD_RUN_GAP = 24;
const GRAPH_SEQUENTIAL_ADD_RUN_OFFSET = {
	x: GRAPH_RUN_NODE_WIDTH + GRAPH_ADD_RUN_GAP,
	y: (GRAPH_RUN_NODE_HEIGHT - GRAPH_ADD_RUN_NODE_HEIGHT) / 2,
};
const GRAPH_EDGE = {
	type: "homeOrthogonal" as const,
	interactionWidth: 18,
};
const HOME_EDGE_TYPES = { homeOrthogonal: HomeOrthogonalEdge };
const AUTO_CONTINUE_MESSAGE = "Continue from the previous run state. If the prior run stopped unexpectedly, inspect the current worktree state and proceed with the original task without restarting from scratch.";

function HomeOrthogonalEdge({
	id,
	source,
	target,
	sourceX,
	sourceY,
	targetX,
	targetY,
	markerStart,
	markerEnd,
	style,
	interactionWidth,
}: EdgeProps) {
	const nodeGap = 12;
	const withGap = (x: number, y: number, otherX: number, otherY: number, nodeId: string) => {
		if (!nodeId.startsWith("add-run:")) return { x, y };
		const dx = otherX - x;
		const dy = otherY - y;
		if (Math.abs(dx) >= Math.abs(dy)) return { x: x + Math.sign(dx || 1) * nodeGap, y };
		return { x, y: y + Math.sign(dy || 1) * nodeGap };
	};
	const start = withGap(sourceX, sourceY, targetX, targetY, source);
	const end = withGap(targetX, targetY, sourceX, sourceY, target);
	const horizontal = Math.abs(start.y - end.y) < 1;
	const busGap = Math.min(96, Math.max(36, Math.abs(end.x - start.x) / 2));
	const busX = start.x <= end.x ? Math.max(start.x + 24, end.x - busGap) : Math.min(start.x - 24, end.x + busGap);
	const path = horizontal
		? `M ${start.x},${start.y} L ${end.x},${end.y}`
		: `M ${start.x},${start.y} L ${busX},${start.y} L ${busX},${end.y} L ${end.x},${end.y}`;
	return (
		<BaseEdge
			id={id}
			path={path}
			{...(markerStart ? { markerStart } : {})}
			{...(markerEnd ? { markerEnd } : {})}
			{...(style ? { style } : {})}
			interactionWidth={interactionWidth ?? 18}
		/>
	);
}

function sameJson<T>(left: T, right: T) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function graphViewportStateKey(scopeKey: string) {
	return `home-graph:${scopeKey}:viewport`;
}

function isGraphViewport(value: unknown): value is Viewport {
	if (!value || typeof value !== "object") return false;
	const viewport = value as Partial<Viewport>;
	return [viewport.x, viewport.y, viewport.zoom].every((item) => typeof item === "number" && Number.isFinite(item));
}

function readGraphViewport(scopeKey: string, signature: string) {
	const state = getPageState<GraphViewportState>(graphViewportStateKey(scopeKey), {});
	const sizeMatches = state.size
		? Math.abs(state.size.width - window.innerWidth) < 80 && Math.abs(state.size.height - window.innerHeight) < 80
		: false;
	return state.signature === signature && sizeMatches && isGraphViewport(state.viewport) ? state.viewport : undefined;
}

function saveGraphViewport(scopeKey: string, viewport: Viewport, signature: string) {
	if (!signature || !isGraphViewport(viewport)) return;
	try {
		setPageState<GraphViewportState>(graphViewportStateKey(scopeKey), {
			viewport,
			signature,
			size: { width: window.innerWidth, height: window.innerHeight },
		});
	} catch {
		// localStorage may be unavailable/private; graph still works without persistence.
	}
}

function GraphViewportSync({ scopeKey, signature }: { scopeKey: string; signature: string }) {
	const { fitView, setViewport } = useReactFlow();
	useEffect(() => {
		if (!signature) return;
		const savedViewport = readGraphViewport(scopeKey, signature);
		const frame = window.requestAnimationFrame(() => {
			if (savedViewport) void setViewport(savedViewport, { duration: 0 });
			else void fitView({ padding: 0.14, duration: 220 });
		});
		return () => window.cancelAnimationFrame(frame);
	}, [fitView, scopeKey, setViewport, signature]);
	return null;
}

function buildGraph({
	project,
	tasks,
	runs,
	worktrees,
	onContinueRun,
	onRetryRun,
	onDeleteRun,
	busyRunId,
}: {
	project: Project | undefined;
	tasks: Task[];
	runs: AgentRun[];
	worktrees: Worktree[];
	onContinueRun?: ((runId: string) => void) | undefined;
	onRetryRun?: ((runId: string) => void) | undefined;
	onDeleteRun?: ((runId: string) => void) | undefined;
	busyRunId?: string;
}) {
	const nodes: GraphNode[] = [];
	const edges: Edge[] = [];
	const worktreeById = new Map(worktrees.map((worktree) => [worktree.id, worktree]));
	const runsByTask = new Map<string, AgentRun[]>();
	for (const run of runs) {
		const group = runsByTask.get(run.taskId) ?? [];
		group.push(run);
		runsByTask.set(run.taskId, group);
	}
	const orderedTasks = [...tasks].sort(
		(a, b) =>
			taskStatusOrder[a.status] - taskStatusOrder[b.status] ||
			b.updatedAt.localeCompare(a.updatedAt),
	);
	const projectId = project ? `project:${project.id}` : "project:none";
	let cursorY = GRAPH_ROW_START_Y;
	const rows = orderedTasks.map((task) => {
		const taskRuns = runsByTask.get(task.id) ?? [];
		const layout = buildRunLayout(taskRuns);
		const height = Math.max(360, (layout.laneCount + 2) * GRAPH_RUN_LANE_GAP + 32);
		const top = cursorY;
		const y = top + height / 2;
		cursorY += height + GRAPH_ROW_GAP;
		return { task, taskRuns, layout, y, top, height };
	});
	const graphCenterY = rows.length ? (rows[0]!.y + rows.at(-1)!.y) / 2 : GRAPH_ROW_START_Y + 96;
	nodes.push({
		id: projectId,
		position: { x: GRAPH_X.project, y: graphCenterY - 70 },
		data: {
			kind: "project",
			label: (
				<NodeCard
					eyebrow="Project"
					title={project?.name ?? "Pick project"}
					meta={project?.rootPath ?? "Add or select project from top picker."}
					accent="project"
				/>
			),
		},
		className: "home-flow-node project-node",
		sourcePosition: Position.Right,
	});

	for (const row of rows) {
		const { task, taskRuns, layout, top } = row;
		const taskLaneAnchorY = top + 16 + ((layout.laneCount - 1) * GRAPH_RUN_LANE_GAP) / 2;
		const activeTaskRuns = activeRuns(taskRuns);
		const taskId = `task:${task.id}`;
		const worktree = task.worktreeId ? worktreeById.get(task.worktreeId) : undefined;
		nodes.push({
			id: taskId,
			position: { x: GRAPH_X.task, y: taskLaneAnchorY },
			data: {
				kind: "task",
				taskId: task.id,
				label: (
					<NodeCard
						eyebrow="Task"
						title={task.title}
						status={task.status}
						meta={
							<>
								<span>worktree: {worktreeName(worktree)}</span>
								<span>{taskRuns.length} run{taskRuns.length === 1 ? "" : "s"}</span>
							</>
						}
					/>
				),
			},
			className: "home-flow-node task-node",
			targetPosition: Position.Left,
			sourcePosition: Position.Right,
		});
		edges.push({
			...GRAPH_EDGE,
			id: `${projectId}->${taskId}`,
			source: projectId,
			target: taskId,
			className: "home-edge",
		});

		const activeChildrenByParent = new Map<string, AgentRun[]>();
		for (const run of activeTaskRuns) {
			if (!run.parentRunId) continue;
			const children = activeChildrenByParent.get(run.parentRunId) ?? [];
			children.push(run);
			activeChildrenByParent.set(run.parentRunId, children);
		}
		let maxDepth = 0;
		for (const run of layout.sorted) {
			const position = layout.positions.get(run.id) ?? { depth: 0, lane: 0 };
			maxDepth = Math.max(maxDepth, position.depth);
			const runId = `run:${run.id}`;
			const x = GRAPH_X.run + position.depth * GRAPH_RUN_DEPTH_GAP;
			const runY = top + position.lane * GRAPH_RUN_LANE_GAP + 16;
			nodes.push({
				id: runId,
				position: { x, y: runY },
				data: {
					kind: "run",
					runId: run.id,
					taskId: task.id,
					label: (
						<NodeCard
							eyebrow={`Run - ${compactId(run.id)}`}
							title={run.deletedAt ? "Trashed" : run.request || run.mainAgentName || "Agent run"}
							status={run.status}
							meta={new Date(run.startedAt).toLocaleString()}
							accent={[run.status === "running" ? "live" : "", run.deletedAt ? "deleted" : ""].filter(Boolean).join(" ") || undefined}
							actions={
								<RunNodeActions
									run={run}
									busy={busyRunId === run.id}
									onContinueRun={onContinueRun}
									onRetryRun={onRetryRun}
									onDeleteRun={onDeleteRun}
								/>
							}
						/>
					),
				},
				className: "home-flow-node run-node",
				targetPosition: Position.Left,
				sourcePosition: Position.Right,
			});
			const source = run.parentRunId ? `run:${run.parentRunId}` : taskId;
			edges.push({
				...GRAPH_EDGE,
				id: `${source}->${runId}`,
				source,
				target: runId,
				animated: run.status === "running",
				className: `home-edge edge-${run.status}`,
			});
			if (!run.deletedAt && !(activeChildrenByParent.get(run.id)?.length)) {
				const addNextStepId = `add-run:${task.id}:next:${run.id}`;
				nodes.push({
					id: addNextStepId,
					position: {
						x: x + GRAPH_SEQUENTIAL_ADD_RUN_OFFSET.x,
						y: runY + GRAPH_SEQUENTIAL_ADD_RUN_OFFSET.y,
					},
					data: {
						kind: "add-run",
						taskId: task.id,
						relation: "sequential",
						parentRunId: run.id,
						label: <AddRunNodeCard label="New sequential run" />,
					},
					className: "home-flow-node add-node add-run-node add-run-inline-node",
					targetPosition: Position.Left,
					sourcePosition: Position.Right,
				});
			}
		}

		const addParallelId = `add-run:${task.id}:parallel`;
		nodes.push({
			id: addParallelId,
			position: { x: GRAPH_X.run, y: top + (layout.laneCount + 1) * GRAPH_RUN_LANE_GAP + 16 },
			data: {
				kind: "add-run",
				taskId: task.id,
				relation: "parallel",
				label: <AddRunNodeCard label="New parallel run" />,
			},
			className: "home-flow-node add-node add-run-node add-run-parallel-node",
			targetPosition: Position.Left,
			sourcePosition: Position.Right,
		});
		edges.push({
			...GRAPH_EDGE,
			id: `${taskId}->${addParallelId}`,
			source: taskId,
			target: addParallelId,
			className: "home-edge edge-add",
		});

		if (activeTaskRuns.length) {
			const reviewId = `review:${task.id}`;
			const reviewRuns = activeTaskRuns.filter((run) => !(activeChildrenByParent.get(run.id)?.length));
			const state = reviewState(task, activeTaskRuns);
			nodes.push({
				id: reviewId,
				position: { x: Math.max(GRAPH_X.review, GRAPH_X.run + (maxDepth + 1) * GRAPH_RUN_DEPTH_GAP), y: taskLaneAnchorY },
				data: {
					kind: "review",
					taskId: task.id,
					label: (
						<NodeCard
							eyebrow="Gate"
							title="Task gate"
							status={state}
							meta={`${activeTaskRuns.filter((run) => run.status === "done").length}/${activeTaskRuns.length} active runs done`}
						/>
					),
				},
				className: "home-flow-node review-node",
				targetPosition: Position.Left,
				sourcePosition: Position.Right,
			});
			for (const run of reviewRuns) {
				const addNextStepId = `add-run:${task.id}:next:${run.id}`;
				edges.push(
					{
						...GRAPH_EDGE,
						id: `run:${run.id}->${addNextStepId}`,
						source: `run:${run.id}`,
						target: addNextStepId,
						animated: run.status === "running",
						className: `home-edge edge-${run.status}`,
					},
					{
						...GRAPH_EDGE,
						id: `${addNextStepId}->${reviewId}`,
						source: addNextStepId,
						target: reviewId,
						className: "home-edge edge-review",
					},
				);
			}
		}
	}

	const addTaskY = rows.length ? rows.at(-1)!.top + rows.at(-1)!.height - 96 : graphCenterY + 140;
	nodes.push({
		id: "add-task",
		position: { x: GRAPH_X.task, y: addTaskY },
		data: {
			kind: "add-task",
			label: <NodeCard eyebrow="NEW TASK" title="" accent="plus candidate" />,
		},
		className: "home-flow-node add-node",
		targetPosition: Position.Left,
		sourcePosition: Position.Right,
	});
	edges.push({
		...GRAPH_EDGE,
		id: `${projectId}->add-task`,
		source: projectId,
		target: "add-task",
		className: "home-edge edge-add",
	});
	return { nodes, edges };
}

function projectionNodeClassName(node: GraphProjectionNode) {
	if (node.kind === "project") return "home-flow-node project-node";
	if (node.kind === "annotation") return "home-flow-node annotation-node";
	if (node.kind === "annotation-tasks") return "home-flow-node annotation-tasks-node";
	if (node.kind === "task") return "home-flow-node task-node";
	if (node.kind === "run") return node.lane === "gate" ? "home-flow-node run-node gate-run-node" : node.lane === "ship" ? "home-flow-node run-node ship-run-node" : node.lane === "annotation" ? "home-flow-node run-node annotation-run-node" : "home-flow-node run-node";
	if (node.kind === "checkpoint" || node.kind === "review") return "home-flow-node review-node checkpoint-node";
	if (node.kind === "ship") return "home-flow-node review-node ship-node";
	if (node.kind === "add-run")
		return [
			"home-flow-node",
			"add-node",
			"add-run-node",
			node.relation === "sequential" ? "add-run-inline-node" : "add-run-parallel-node",
			node.lane ? `add-run-lane-${node.lane}` : "",
		]
			.filter(Boolean)
			.join(" ");
	return "home-flow-node add-node";
}

function projectionNodePositions(node: GraphProjectionNode) {
	if (node.kind === "project") return { sourcePosition: Position.Right };
	if (node.kind === "add-task") return { targetPosition: Position.Left, sourcePosition: Position.Right };
	return { targetPosition: Position.Left, sourcePosition: Position.Right };
}

function projectionMeta(meta: string[] | undefined) {
	if (!meta?.length) return undefined;
	return <>{meta.map((item) => <span key={item}>{item}</span>)}</>;
}

function renderGraphProjection({
	projection,
	onContinueRun,
	onRetryRun,
	onDeleteRun,
	onArchiveTask,
	busyRunId,
	archivingTaskId,
	onNavigate,
}: {
	projection: GraphProjection | null;
	onContinueRun?: ((runId: string) => void) | undefined;
	onRetryRun?: ((runId: string) => void) | undefined;
	onDeleteRun?: ((runId: string) => void) | undefined;
	onArchiveTask?: ((projectId: string, taskId: string) => void) | undefined;
	busyRunId?: string;
	archivingTaskId?: string;
	onNavigate: (href: string) => void;
}) {
	if (!projection) return { nodes: [], edges: [] };
	const runsById = new Map(projection.runs.map((run) => [run.id, run]));
	const nodes: GraphNode[] = projection.nodes.map((node) => {
		const run = node.kind === "run" && node.runId ? runsById.get(node.runId) : undefined;
		const label = node.kind === "add-run" ? (
			<AddRunNodeCard label={node.eyebrow} />
		) : (
			<NodeCard
				eyebrow={node.eyebrow}
				title={node.title}
				status={node.status}
				meta={projectionMeta(node.meta)}
				accent={node.accent}
				actions={run ? (
					<RunNodeActions
						run={run}
						busy={busyRunId === run.id}
						onContinueRun={onContinueRun}
						onRetryRun={onRetryRun}
						onDeleteRun={onDeleteRun}
					/>
				) : node.kind === "task" ? (
					<TaskNodeActions
						actions={node.actions}
						onNavigate={onNavigate}
						archiving={archivingTaskId === node.taskId}
						onArchiveTask={node.projectId && node.taskId && onArchiveTask ? () => onArchiveTask(node.projectId!, node.taskId!) : undefined}
					/>
				) : (
					<span
						onClick={(event) => event.stopPropagation()}
						onMouseDown={(event) => event.stopPropagation()}
						onPointerDown={(event) => event.stopPropagation()}
					>
						<NodeQuickActions actions={node.actions} onNavigate={onNavigate} />
					</span>
				)}
			/>
		);
		return {
			id: node.id,
			position: node.position,
			data: {
				kind: node.kind,
				projectId: node.projectId,
				annotationId: node.annotationId,
				taskId: node.taskId,
				runId: node.runId,
				worktreeId: node.worktreeId,
				relation: node.relation,
				lane: node.lane,
				parentRunId: node.parentRunId,
				href: node.href,
				label,
			},
			className: projectionNodeClassName(node),
			...projectionNodePositions(node),
		};
	});
	const edges: Edge[] = projection.edges.map((edge) => ({
		...GRAPH_EDGE,
		id: edge.id,
		source: edge.source,
		target: edge.target,
		...(edge.animated !== undefined ? { animated: edge.animated } : {}),
		className: ["home-edge", edge.status ? `edge-${edge.status}` : "", edge.kind === "add" ? "edge-add" : "", edge.kind === "review" || edge.kind === "checkpoint" ? "edge-review" : "", edge.kind === "gate" ? "edge-gate" : "", edge.kind === "ship" ? "edge-ship" : "", edge.kind === "annotation" || edge.kind === "annotation-run" || edge.kind === "annotation-tasks" ? "edge-annotation" : ""]
			.filter(Boolean)
			.join(" "),
	}));
	return { nodes, edges };
}

function TaskDialog({
	mode,
	task,
	worktree,
	projectId = "",
	onClose,
	onSave,
	onViewDiff,
}: {
	mode: "create" | "view";
	task: Task | undefined;
	worktree: Worktree | undefined;
	projectId?: string;
	onClose: () => void;
	onSave: (input: { title: string; body: string; worktreeId?: string }) => Promise<void>;
	onViewDiff?: (() => void) | undefined;
}) {
	const [editing, setEditing] = useState(mode === "create");
	const [title, setTitle] = useState(task?.title ?? "");
	const [body, setBody] = useState(task?.body ?? "");
	const [selectedWorktreeId, setSelectedWorktreeId] = useState("");
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		setEditing(mode === "create");
		setTitle(task?.title ?? "");
		setBody(task?.body ?? "");
		setSelectedWorktreeId(task?.worktreeId ?? "");
	}, [mode, task?.id, task?.title, task?.body, task?.worktreeId]);
	async function save() {
		if (!title.trim() || saving) return;
		setSaving(true);
		try {
			await onSave({
				title: title.trim(),
				body,
				...(mode === "create" && selectedWorktreeId ? { worktreeId: selectedWorktreeId } : {}),
			});
			onClose();
		} finally {
			setSaving(false);
		}
	}
	return (
		<div className="home-modal-backdrop" role="presentation" onMouseDown={onClose}>
			<section className="home-modal task-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
				<div className="home-modal-head">
					<div>
						<small>{mode === "create" ? "Create" : "Task"}</small>
						<h2>{mode === "create" ? "New task" : task?.title}</h2>
					</div>
					<button type="button" onClick={onClose}>×</button>
				</div>
				{mode === "view" && task && !editing ? (
					<div className="home-modal-body">
						<div className="task-dialog-meta">
							<span className={`task-status status-${task.status}`}>{labelStatus(task.status)}</span>
							<span>worktree: {worktreeName(worktree)}</span>
						</div>
						<MarkdownText text={task.body || "No details."} />
						<div className="home-modal-actions">
							<button type="button" disabled={!worktree || !onViewDiff} title={worktree ? "View task worktree diff" : "Task has no worktree yet"} onClick={onViewDiff}>View Diff</button>
							<button type="button" onClick={() => setEditing(true)}>Edit</button>
						</div>
					</div>
				) : (
					<form className="home-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
						<label>
							Title
							<input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
						</label>
						<label>
							Details
							<textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Describe expected change, constraints, tests, success signal..." />
						</label>
						{mode === "create" ? (
							<div className="task-worktree-picker">
								<span>Task worktree</span>
								<WorktreePicker projectId={projectId} value={selectedWorktreeId} onChange={setSelectedWorktreeId} allowNewWorktree showAdd={false} />
								<small>{selectedWorktreeId ? "Attach task to existing worktree. First run uses it." : "Default: create isolated worktree on first run."}</small>
							</div>
						) : null}
						<div className="home-modal-actions">
							{mode === "view" ? <button type="button" onClick={() => setEditing(false)}>Cancel edit</button> : null}
							<button type="submit" disabled={!title.trim() || saving}>{saving ? "Saving…" : "Save task"}</button>
						</div>
					</form>
				)}
			</section>
		</div>
	);
}

function NewRunDialog({
	task,
	initialRelation,
	parentRunId,
	onClose,
	lane = "task",
	onStart,
}: {
	task: Task;
	initialRelation: RunRelation;
	lane?: RunLane;
	parentRunId: string | undefined;
	onClose: () => void;
	onStart: (input: { message: string; relation: RunRelation; lane: RunLane; parentRunId?: string }) => Promise<void>;
}) {
	const [relation, setRelation] = useState<RunRelation>(initialRelation);
	const [message, setMessage] = useState(() => getPageState("home-new-run", { message: "" }).message);
	const [starting, setStarting] = useState(false);
	useEffect(() => setPageState("home-new-run", { message }), [message]);
	async function start() {
		if (!message.trim() || starting) return;
		setStarting(true);
		try {
			await onStart({
				message: message.trim(),
				relation,
				lane,
				...(relation === "sequential" && parentRunId ? { parentRunId } : {}),
			});
			setMessage("");
			setPageState("home-new-run", { message: "" });
			onClose();
		} finally {
			setStarting(false);
		}
	}
	return (
		<div className="home-modal-backdrop" role="presentation" onMouseDown={onClose}>
			<section className="home-modal run-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
				<div className="home-modal-head">
					<div>
						<small>{lane === "gate" ? "New gate run" : "New run"}</small>
						<h2>{task.title}</h2>
					</div>
					<button type="button" onClick={onClose}>×</button>
				</div>
				<form className="home-form" onSubmit={(e) => { e.preventDefault(); void start(); }}>
					<div className="relation-picker">
						<button type="button" className={relation === "parallel" ? "active" : ""} onClick={() => setRelation("parallel")}>Parallel</button>
						<button type="button" className={relation === "sequential" ? "active" : ""} onClick={() => setRelation("sequential")} disabled={!parentRunId}>Sequential</button>
					</div>
					<label>
						Request
						<textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Tell agent what to do in this task worktree..." autoFocus />
					</label>
					<p className="muted">Run starts immediately. Same task worktree. Request not editable after submit.</p>
					<div className="home-modal-actions">
						<button type="button" onClick={onClose}>Cancel</button>
						<button type="submit" disabled={!message.trim() || starting}>{starting ? "Starting…" : "Start run"}</button>
					</div>
				</form>
			</section>
		</div>
	);
}

function ReviewDialog({
	task,
	runs,
	onClose,
	onOpenRun,
	onMarkDone,
}: {
	task: Task;
	runs: AgentRun[];
	onClose: () => void;
	onOpenRun: (runId: string) => void;
	onMarkDone: () => Promise<void>;
}) {
	const [saving, setSaving] = useState(false);
	const state = reviewState(task, runs);
	const allDone = runs.length > 0 && runs.every((run) => run.status === "done");
	async function markDone() {
		if (!allDone || saving) return;
		setSaving(true);
		try {
			await onMarkDone();
			onClose();
		} finally {
			setSaving(false);
		}
	}
	return (
		<div className="home-modal-backdrop" role="presentation" onMouseDown={onClose}>
			<section className="home-modal review-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
				<div className="home-modal-head">
					<div>
						<small>Review</small>
						<h2>{task.title}</h2>
					</div>
					<button type="button" onClick={onClose}>×</button>
				</div>
				<div className="review-status-card">
					<span className={`task-status status-${state}`}>{labelStatus(state)}</span>
					<p>{allDone ? "All upstream runs done. Consolidation can finish." : "Mark each completed run done before consolidation."}</p>
				</div>
				<div className="review-run-list">
					{runs.map((run) => (
						<button type="button" key={run.id} onClick={() => onOpenRun(run.id)}>
							<strong>{compactId(run.id)}</strong>
							<span className={`task-status status-${run.status}`}>{labelStatus(run.status)}</span>
							<small>{run.request || run.mainAgentName || run.startedAt}</small>
						</button>
					))}
				</div>
				<div className="home-modal-actions">
					<button type="button" onClick={onClose}>Close</button>
					<button type="button" disabled={!allDone || task.status === "done" || saving} onClick={() => void markDone()}>{saving ? "Marking…" : "Mark task done"}</button>
				</div>
			</section>
		</div>
	);
}

function ToolBlock({ start, end, open }: { start: RunEvent; end?: RunEvent | undefined; open?: boolean | undefined }) {
	const name = toolName(start.payload, "tool");
	const args = toolArgs(start.payload);
	const argsSummary = toolArgsSummary(name, args);
	const failed = end ? toolFailed(end.payload) : false;
	const normalized = name.toLowerCase();
	const result = end ? toolOutput(end.payload) : undefined;
	const resultPatch = end ? patchFromPayload(end.payload) : undefined;
	const patch = failed && normalized.includes("edit")
		? undefined
		: (resultPatch ??
			(normalized.includes("edit") ? buildEditPatch(args) : undefined) ??
			(normalized.includes("write") ? buildWritePatch(args) : undefined));
	return (
		<details className={`chat-bubble tool-event tool-${end ? (failed ? "failed" : "success") : "running"} ${toolColorClass(name)}`} open={open}>
			<summary><strong>{name}</strong><ToolSummary name={name} summary={argsSummary} /></summary>
			<section className="tool-details-grid">
				<div className="tool-detail-card">
					<h4>Arguments</h4>
					<ToolArgumentsView name={name} args={args} patch={patch} />
				</div>
				{end && result !== undefined ? (
					<div className="tool-detail-card">
						<h4>Result</h4>
						<ToolResultView name={name} args={args} result={result} patch={patch} />
					</div>
				) : null}
			</section>
		</details>
	);
}

function ChatTimeline({ events }: { events: RunEvent[] }) {
	const ordered = [...events].sort((a, b) => a.seq - b.seq);
	const toolEnds = new Map<string, RunEvent>();
	for (const event of ordered) if (isToolEndEvent(event)) toolEnds.set(toolKey(event), event);
	const latestVisibleSeq = [...ordered].reverse().find((event) => !isHiddenEvent(event) && !isToolEndEvent(event))?.seq;
	const rendered: ReactNode[] = [];
	let assistantBuffer = "";
	let assistantKey = "assistant";
	let thinkingBuffer = "";
	let thinkingKey = "thinking";
	function flushAssistant() {
		if (!assistantBuffer) return;
		rendered.push(
			<section key={assistantKey} className="chat-bubble assistant-message message-assistant">
				<strong>Assistant</strong>
				<MarkdownText text={assistantBuffer} />
			</section>,
		);
		assistantBuffer = "";
	}
	function flushThinking() {
		if (!thinkingBuffer) return;
		rendered.push(
			<details key={thinkingKey} className="chat-bubble thinking-block message-thinking">
				<summary>Assistant thinking</summary>
				<MarkdownText text={thinkingBuffer} />
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
				assistantKey = assistantBuffer ? assistantKey : event.id;
				assistantBuffer += text;
				continue;
			}
		}
		if (isThinkingEvent(event)) {
			const text = extractTextDeep(event.payload);
			if (text) {
				flushAssistant();
				thinkingKey = thinkingBuffer ? thinkingKey : event.id;
				thinkingBuffer += text;
				continue;
			}
		}
		flushAssistant();
		flushThinking();
		if (isToolEndEvent(event)) continue;
		if (event.type === "user_message") {
			rendered.push(
				<section key={event.id} className="chat-bubble user-message message-user">
					<strong>User</strong>
					<MarkdownText text={textOf(event.payload)} />
				</section>,
			);
		} else if (event.type === "prompt") {
			rendered.push(
				<details key={event.id} className="chat-bubble message-prompt">
					<summary>Full prompt</summary>
					<pre>{textOf(event.payload)}</pre>
				</details>,
			);
		} else if (isToolStartEvent(event)) {
			const end = toolEnds.get(toolKey(event));
			rendered.push(<ToolBlock key={event.id} start={event} end={end} open={!end && event.seq === latestVisibleSeq} />);
		} else if (event.type === "result") {
			continue;
		} else if (event.type === "error") {
			rendered.push(
				<section key={event.id} className="chat-bubble error message-error">
					<strong>Error</strong>
					<MarkdownText text={textOf(event.payload) || jsonText(event.payload)} />
				</section>,
			);
		} else {
			continue;
		}
	}
	flushAssistant();
	flushThinking();
	return <div className="run-chat-timeline">{rendered}</div>;
}

export function GraphRunChat({
	projectId,
	taskId,
	runId,
	initialRun,
	initialTask,
	onBack,
	onChanged,
}: {
	projectId?: string;
	taskId?: string;
	runId: string;
	initialRun?: AgentRun | undefined;
	initialTask?: Task | undefined;
	onBack: () => void;
	onChanged: () => void;
}) {
	const [run, setRun] = useState<AgentRun | undefined>(initialRun);
	const [task, setTask] = useState<Task | undefined>(initialTask);
	const [events, setEvents] = useState<RunEvent[]>([]);
	const [draft, setDraft] = useState(() => getPageState(`home-run:${runId}`, { draft: "" }).draft);
	const [sending, setSending] = useState(false);
	const [working, setWorking] = useState(false);
	const bottomRef = useRef<HTMLDivElement | null>(null);
	const load = useCallback(async () => {
		const runPath = projectId && taskId
			? `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}`
			: `/runs/${runId}`;
		const nextRun = await apiGet<AgentRun>(runPath);
		const [nextTask, nextEvents] = await Promise.all([
			projectId && taskId
				? apiGet<Task>(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`)
				: apiGet<Task>(`/runs/${encodeURIComponent(runId)}/task`).catch(() => undefined),
			apiGet<RunEvent[]>(`/runs/${runId}/events`),
		]);
		setRun(nextRun);
		setTask(nextTask);
		setEvents(nextEvents);
	}, [projectId, runId, taskId]);
	useEffect(() => { void load(); }, [load]);
	useEffect(() => setPageState(`home-run:${runId}`, { draft }), [draft, runId]);
	useEffect(() => {
		let closed = false;
		let fallback: number | undefined;
		const poll = () => {
			if (fallback || closed) return;
			fallback = window.setInterval(() => { void load(); onChanged(); }, 2500);
		};
		if (typeof EventSource === "undefined") {
			poll();
			return () => { closed = true; if (fallback) window.clearInterval(fallback); };
		}
		const source = new EventSource(`${API_BASE}/runs/${runId}/stream`);
		const handle = (event: MessageEvent<string>) => {
			if (closed) return;
			try {
				const seq = Number(event.lastEventId);
				const item: RunEvent = {
					id: `${runId}:${seq}`,
					runId,
					seq,
					type: event.type,
					payload: JSON.parse(event.data) as unknown,
					createdAt: new Date().toISOString(),
				};
				setEvents((current) => current.some((existing) => existing.seq === item.seq) ? current : [...current, item].sort((a, b) => a.seq - b.seq));
				if (["result", "error", "worktree_switched"].includes(event.type)) {
					void load();
					onChanged();
				}
			} catch {
				source.close();
				poll();
			}
		};
		for (const type of [
			"text_delta",
			"thinking_delta",
			"message_delta_batch",
			"thinking_delta_batch",
			"tool_start",
			"tool_end",
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
		]) source.addEventListener(type, handle as EventListener);
		source.onerror = () => { source.close(); poll(); };
		return () => { closed = true; source.close(); if (fallback) window.clearInterval(fallback); };
	}, [load, onChanged, runId]);
	useEffect(() => {
		if (run?.status === "running") bottomRef.current?.scrollIntoView({ block: "end" });
	}, [events.length, run?.status]);
	async function send() {
		if (!draft.trim() || sending) return;
		setSending(true);
		try {
			await apiPost(projectId && taskId ? `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/messages` : `/runs/${runId}/messages`, { message: draft.trim() });
			setDraft("");
			await load();
			onChanged();
		} finally {
			setSending(false);
		}
	}
	async function cancel() {
		if (working) return;
		setWorking(true);
		try {
			await apiPost(`/runs/${runId}/cancel`, {});
			await load();
			onChanged();
		} finally {
			setWorking(false);
		}
	}
	async function markDone() {
		if (working || run?.status !== "need_review") return;
		setWorking(true);
		try {
			await apiPost(`/runs/${runId}/done`, {});
			await load();
			onChanged();
		} finally {
			setWorking(false);
		}
	}
	const runStatus = run?.status;
	const instructionLine = run ? firstInstructionLine(run.request) : "Loading run details…";
	return (
		<section className="home-run-fullscreen">
			<header className="home-run-topbar">
				<button type="button" className="back-button" onClick={onBack}>← Graph</button>
				<div className="home-run-title">
					<small>{task?.title ?? "Loading task"}</small>
					<h2>{instructionLine}</h2>
				</div>
				<div className="home-run-topbar-actions">
					{runStatus ? <span className={`task-status status-${runStatus}`}>{labelStatus(runStatus)}</span> : null}
					<button type="button" disabled={runStatus !== "running" || working} onClick={() => void cancel()}>Cancel</button>
					<button type="button" disabled={runStatus !== "need_review" || working} onClick={() => void markDone()}>Mark run done</button>
				</div>
			</header>
			<div className="home-run-chat-scroll">
				<ChatTimeline events={events} />
				<div ref={bottomRef} />
			</div>
			<footer className="home-run-input">
				<textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Steer or resume this run..." onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void send(); } }} />
				<button type="button" disabled={!draft.trim() || sending} onClick={() => void send()}>{sending ? "Sending…" : "Send"}</button>
			</footer>
		</section>
	);
}

export function HomePage({
	projectId = "",
	projects,
	projectsLoading,
	projectsLoaded,
	projectsError,
	history = false,
}: {
	projectId?: string;
	projects: Project[];
	projectsLoading: boolean;
	projectsLoaded: boolean;
	projectsError: string;
	history?: boolean;
}) {
	const navigate = useNavigate();
	const scopeKey = `${projectId || "global"}:${history ? "history" : "active"}`;
	const [projection, setProjection] = useState<GraphProjection | null>(null);
	const [tasks, setTasks] = useState<Task[]>([]);
	const [runs, setRuns] = useState<AgentRun[]>([]);
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [loading, setLoading] = useState(false);
	const [loadedScope, setLoadedScope] = useState("");
	const [error, setError] = useState("");
	const [dialog, setDialog] = useState<DialogState>(null);
	const [busyRunId, setBusyRunId] = useState("");
	const [archivingTaskId, setArchivingTaskId] = useState("");
	const refreshSeq = useRef(0);
	const selectedProject = projects.find((project) => project.id === projectId);
	const worktreeById = useMemo(() => new Map(worktrees.map((worktree) => [worktree.id, worktree])), [worktrees]);
	const projectWorktree = useMemo(() => {
		if (!selectedProject) return undefined;
		const scoped = worktrees.filter((worktree) => worktree.projectId === selectedProject.id);
		return scoped.find((worktree) => worktree.branch === "main")
			?? scoped.find((worktree) => worktree.path === selectedProject.rootPath)
			?? scoped.find((worktree) => worktree.branch === "master")
			?? scoped[0];
	}, [selectedProject, worktrees]);
	const runsByTask = useMemo(() => {
		const groups = new Map<string, AgentRun[]>();
		for (const run of runs) {
			const group = groups.get(run.taskId) ?? [];
			group.push(run);
			groups.set(run.taskId, group);
		}
		for (const group of groups.values()) group.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
		return groups;
	}, [runs]);
	const refresh = useCallback(async (silent = false) => {
		const requestId = ++refreshSeq.current;
		const requestedScope = scopeKey;
		if (!silent) setLoading(true);
		try {
			const query = history ? "?history=1" : "";
			const nextProjection = await apiGet<GraphProjection>(
				projectId ? `/projects/${encodeURIComponent(projectId)}/graph${query}` : `/graph${query}`,
			);
			if (refreshSeq.current !== requestId) return;
			setProjection((current) => sameJson(current, nextProjection) ? current : nextProjection);
			setTasks((current) => sameJson(current, nextProjection.tasks) ? current : nextProjection.tasks);
			setRuns((current) => sameJson(current, nextProjection.runs) ? current : nextProjection.runs);
			setWorktrees((current) => sameJson(current, nextProjection.worktrees) ? current : nextProjection.worktrees);
			setLoadedScope(requestedScope);
			setError("");
		} catch (nextError) {
			if (refreshSeq.current !== requestId) return;
			setProjection(null);
			setLoadedScope(requestedScope);
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			if (refreshSeq.current === requestId && !silent) setLoading(false);
		}
	}, [history, projectId, scopeKey]);
	useEffect(() => { void refresh(); }, [refresh]);
	const hasActiveRuns = loadedScope === scopeKey && runs.some((run) => run.status === "running" || run.status === "queued");
	useEffect(() => {
		const timer = window.setInterval(() => { void refresh(true); }, hasActiveRuns ? 4000 : 15000);
		return () => window.clearInterval(timer);
	}, [hasActiveRuns, refresh]);
	const handleNodeClick: NodeMouseHandler = useCallback((_, node) => {
		const data = node.data as GraphNodeData;
		if (data.kind === "project" && data.projectId) {
			navigate(data.href || `/projects/${encodeURIComponent(data.projectId)}`);
			return;
		}
		if (data.kind === "annotation" && data.projectId) {
			navigate(data.href || `/projects/${encodeURIComponent(data.projectId)}/annotations`);
			return;
		}
		if (data.kind === "annotation-tasks" && data.projectId) {
			navigate(data.href || `/projects/${encodeURIComponent(data.projectId)}/annotation-tasks`);
			return;
		}
		if (data.kind === "add-task" && data.projectId) {
			setDialog({ type: "create-task", projectId: data.projectId });
			return;
		}
		if (data.kind === "task" && data.projectId && data.taskId) {
			setSelectedTaskId(data.taskId);
			navigate(data.href || `/projects/${encodeURIComponent(data.projectId)}/tasks/${encodeURIComponent(data.taskId)}`);
			return;
		}
		if ((data.kind === "checkpoint" || data.kind === "review") && data.projectId && data.taskId) {
			setSelectedTaskId(data.taskId);
			navigate(data.href || `/projects/${encodeURIComponent(data.projectId)}/tasks/${encodeURIComponent(data.taskId)}/checkpoint`);
			return;
		}
		if (data.kind === "ship" && data.projectId && data.taskId) {
			setSelectedTaskId(data.taskId);
			navigate(data.href || `/projects/${encodeURIComponent(data.projectId)}/tasks/${encodeURIComponent(data.taskId)}/ship`);
			return;
		}
		if (data.kind === "run" && data.projectId && data.runId) {
			setSelectedRunId(data.runId);
			if (data.href) navigate(data.href);
			else if (data.taskId) navigate(`/projects/${encodeURIComponent(data.projectId)}/tasks/${encodeURIComponent(data.taskId)}/runs/${encodeURIComponent(data.runId)}`);
			else navigate(`/projects/${encodeURIComponent(data.projectId)}/annotation-runs/${encodeURIComponent(data.runId)}`);
			return;
		}
		if (data.kind === "add-run" && data.taskId && data.relation)
			setDialog({
				type: "new-run",
				taskId: data.taskId,
				relation: data.relation,
				...(data.lane ? { lane: data.lane } : {}),
				...(data.parentRunId ? { parentRunId: data.parentRunId } : {}),
			});
	}, [navigate]);
	async function saveTask(input: { title: string; body: string; worktreeId?: string }, taskId?: string) {
		const existingTask = taskId ? tasks.find((task) => task.id === taskId) : undefined;
		const targetProjectId = existingTask?.projectId ?? (dialog?.type === "create-task" ? dialog.projectId : projectId);
		if (!targetProjectId) return;
		if (taskId) await apiPatch<Task>(`/projects/${encodeURIComponent(targetProjectId)}/tasks/${encodeURIComponent(taskId)}`, input);
		else await apiPost<Task>(`/projects/${encodeURIComponent(targetProjectId)}/tasks`, input);
		await refresh(true);
	}
	async function startRun(input: { taskId: string; message: string; relation: RunRelation; lane?: RunLane; parentRunId?: string }) {
		const task = tasks.find((row) => row.id === input.taskId);
		if (!task) return;
		const run = await apiPost<AgentRun>(`/projects/${encodeURIComponent(task.projectId)}/tasks/${encodeURIComponent(task.id)}/runs`, {
			message: input.message,
			relation: input.relation,
			...(input.lane ? { lane: input.lane } : {}),
			...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
		});
		await refresh(true);
		setSelectedRunId(run.id);
		navigate(`/projects/${encodeURIComponent(task.projectId)}/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.id)}`);
	}
	const continueRun = useCallback(async (runId: string) => {
		if (busyRunId) return;
		const source = runs.find((run) => run.id === runId);
		const task = source ? tasks.find((row) => row.id === source.taskId) : undefined;
		if (!source) return;
		setBusyRunId(runId);
		try {
			await apiPost(task ? `/projects/${encodeURIComponent(task.projectId)}/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(runId)}/messages` : `/runs/${encodeURIComponent(runId)}/messages`, { message: AUTO_CONTINUE_MESSAGE });
			await refresh(true);
		} finally {
			setBusyRunId("");
		}
	}, [busyRunId, refresh, runs, tasks]);
	const retryRun = useCallback(async (runId: string) => {
		if (busyRunId) return;
		const source = runs.find((run) => run.id === runId);
		const task = source ? tasks.find((row) => row.id === source.taskId) : undefined;
		if (!source || !task) return;
		setBusyRunId(runId);
		try {
			const run = await apiPost<AgentRun>(`/projects/${encodeURIComponent(task.projectId)}/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(runId)}/retry`, {});
			await refresh(true);
			setSelectedRunId(run.id);
			navigate(`/projects/${encodeURIComponent(task.projectId)}/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.id)}`);
		} finally {
			setBusyRunId("");
		}
	}, [busyRunId, navigate, refresh, runs, tasks]);
	const deleteRun = useCallback(async (runId: string) => {
		if (busyRunId || history) return;
		const source = runs.find((run) => run.id === runId);
		const task = source ? tasks.find((row) => row.id === source.taskId) : undefined;
		if (!source) return;
		setBusyRunId(runId);
		try {
			await apiDelete<AgentRun>(task ? `/projects/${encodeURIComponent(task.projectId)}/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(runId)}` : `/runs/${encodeURIComponent(runId)}`);
			await refresh(true);
		} finally {
			setBusyRunId("");
		}
	}, [busyRunId, history, refresh, runs, tasks]);
	const archiveTaskFromNode = useCallback(async (targetProjectId: string, targetTaskId: string) => {
		if (history || archivingTaskId) return;
		if (!window.confirm("Archive task and remove its task worktree/local branch if present?")) return;
		setArchivingTaskId(targetTaskId);
		try {
			await apiPost(`/projects/${encodeURIComponent(targetProjectId)}/tasks/${encodeURIComponent(targetTaskId)}/archive`, { cleanup: true });
			await refresh(true);
		} finally {
			setArchivingTaskId("");
		}
	}, [archivingTaskId, history, refresh]);
	const canRenderGraph = Boolean(projection && loadedScope === scopeKey && (!projectId || selectedProject));
	const graph = useMemo(() => canRenderGraph ? renderGraphProjection({
		projection,
		onContinueRun: history ? undefined : (runId) => { void continueRun(runId); },
		onRetryRun: history ? undefined : (runId) => { void retryRun(runId); },
		onDeleteRun: history ? undefined : (runId) => { void deleteRun(runId); },
		onArchiveTask: history ? undefined : (targetProjectId, targetTaskId) => { void archiveTaskFromNode(targetProjectId, targetTaskId); },
		busyRunId,
		archivingTaskId,
		onNavigate: navigate,
	}) : { nodes: [], edges: [] }, [archiveTaskFromNode, archivingTaskId, busyRunId, canRenderGraph, continueRun, deleteRun, history, navigate, projection, retryRun]);
	const graphLayoutSignature = useMemo(() => graph.nodes.map((node) => `${node.id}:${Math.round(node.position.x)},${Math.round(node.position.y)}`).join("|"), [graph.nodes]);
	const handleGraphMoveEnd = useCallback((_: globalThis.MouseEvent | TouchEvent | null, viewport: Viewport) => {
		saveGraphViewport(scopeKey, viewport, graphLayoutSignature);
	}, [graphLayoutSignature, scopeKey]);
	async function markTaskDone(taskId: string) {
		const task = tasks.find((row) => row.id === taskId);
		if (!task) return;
		await apiPost(`/projects/${encodeURIComponent(task.projectId)}/tasks/${encodeURIComponent(task.id)}/checkpoints`, {});
		await refresh(true);
	}
	const newRunTask = dialog?.type === "new-run" ? tasks.find((task) => task.id === dialog.taskId) : undefined;
	const projectBootstrapping = !projectsLoaded;
	const graphHydrating = loadedScope !== scopeKey || Boolean(projectId && !selectedProject);
	const graphBusy = loading || projectsLoading || projectBootstrapping || graphHydrating;
	return (
		<section className="home-page">
			{projectsError || error ? (
				<div className="home-errors">
					{projectsError ? <p className="error home-error">{projectsError}</p> : null}
					{error ? <p className="error home-error">{error}</p> : null}
				</div>
			) : null}
			{selectedProject && projectWorktree ? (
				<nav className="home-project-toolbar" aria-label="Project workspace">
					<div>
						<strong>{history ? `${selectedProject.name} history` : selectedProject.name}</strong>
						<small>{history ? "Archived tasks" : projectWorktree.branch || projectWorktree.path}</small>
					</div>
					{history ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(selectedProject.id)}`}>Active graph</Link> : <Link className="home-action-link" to={`/projects/${encodeURIComponent(selectedProject.id)}/history`}>History</Link>}
					{!history ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(selectedProject.id)}/annotations?${new URLSearchParams({ worktreeId: projectWorktree.id })}`}>Annotations</Link> : null}
					{!history ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(selectedProject.id)}/annotation-tasks`}>AnnotationTasks</Link> : null}
					{!history ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(selectedProject.id)}/worktrees/${encodeURIComponent(projectWorktree.id)}/files`}>Files</Link> : null}
					{!history ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(selectedProject.id)}/worktrees/${encodeURIComponent(projectWorktree.id)}/diffs`}>Diffs</Link> : null}
				</nav>
			) : null}
			<div className="home-graph-shell">
				<div className="home-graph-actions">
					{graphBusy ? <BusyIndicator label={canRenderGraph ? "Syncing graph" : "Loading graph"} /> : null}
					{history && !projectId ? <Link className="home-action-link" to="/">Active graph</Link> : null}
					<button type="button" onClick={() => void refresh()} disabled={loading || projectBootstrapping}>Refresh</button>
				</div>
				{projectBootstrapping || graphHydrating ? (
					<div className="home-empty home-graph-loading-state">
						<BusyIndicator label="Loading graph" />
						<p>Preparing project graph.</p>
					</div>
				) : !projection?.nodes.length ? (
					<div className="home-empty">
						<h3>{history ? "No history yet" : "No graph nodes"}</h3>
						<p>{history ? "Archived tasks appear here." : "Add a project or task. Graph opens here."}</p>
					</div>
				) : (
					<ReactFlow
						key={scopeKey}
						nodes={graph.nodes}
						edges={graph.edges}
						onNodeClick={handleNodeClick}
						onMoveEnd={handleGraphMoveEnd}
						nodesDraggable={false}
						nodesConnectable={false}
						elementsSelectable
						panOnScroll
						panOnDrag
						minZoom={0.08}
						maxZoom={1.6}
						edgeTypes={HOME_EDGE_TYPES}
						proOptions={{ hideAttribution: true }}
					>
						<GraphViewportSync scopeKey={scopeKey} signature={graphLayoutSignature} />
						<Background color="#164436" gap={24} />
						<Controls />
					</ReactFlow>
				)}
			</div>
			{dialog?.type === "create-task" ? (
				<TaskDialog mode="create" task={undefined} worktree={undefined} projectId={dialog.projectId ?? projectId} onClose={() => setDialog(null)} onSave={(input) => saveTask(input)} />
			) : null}
			{dialog?.type === "new-run" && newRunTask ? (
				<NewRunDialog
					task={newRunTask}
					initialRelation={dialog.relation}
					{...(dialog.lane ? { lane: dialog.lane } : {})}
					parentRunId={dialog.parentRunId}
					onClose={() => setDialog(null)}
					onStart={(input) => startRun({ taskId: newRunTask.id, ...input })}
				/>
			) : null}
		</section>
	);
}
