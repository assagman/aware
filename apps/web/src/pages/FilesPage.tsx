import type { AgentRun, Annotation } from "@aware/shared";
import type {
	DiffLineAnnotation,
	FileDiffMetadata,
	OnDiffLineClickProps,
	SelectedLineRange,
} from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, apiGet, apiPost } from "../app/api";
import { getPageState, setPageState } from "../app/pageState";
import {
	getSelectedProjectId,
	getSelectedWorktreeId,
	getSelection,
	setSelectedProjectId,
	setSelectedRunId,
	setSelectedWorktreeId,
} from "../app/selection";
import { AgentPicker } from "../components/AgentPicker";
import { AnnotationsPanel } from "../components/AnnotationsPanel";
import { BusyIndicator } from "../components/BusyIndicator";
import { ProjectColumn } from "../components/ProjectColumn";
import { RunLink } from "../components/RunLink";
import { WorktreeColumn } from "../components/WorktreeColumn";
import { FileTreeView } from "../components/FileTreeView";

type ViewMode = "file" | "diff";
type DiffSectionId = "committed" | "staged" | "unstaged";
type DiffPatches = Record<DiffSectionId, string>;
type Ann = { text: string };
type LocalDiffAnnotation = DiffLineAnnotation<Ann> & { filePath?: string | undefined };

const initialState = getPageState("files", {
	note: "",
	comment: "",
	filesMessage: "",
	filesChatAgentId: "",
	viewMode: "file" as ViewMode,
	file: "",
	annotationMode: null as "file" | "selection" | null,
	anchorLine: null as number | null,
	endLine: null as number | null,
	selectedDiffFile: "",
	selectedDiff: null as SelectedLineRange | null,
});

function parseDiffFiles(patch: string) {
	try {
		return parsePatchFiles(patch, "aware-diff", false).flatMap(
			(parsed) => parsed.files,
		);
	} catch {
		return [];
	}
}

function diffFiles(patch: string) {
	return [...patch.matchAll(/^diff --git a\/(.*?) b\//gm)].map((m) => m[1]);
}

function annotationSide(annotation: Annotation) {
	return annotation.side === "deletions" || annotation.side === "old"
		? "deletions"
		: "additions";
}

function toDiffAnnotation(annotation: Annotation): LocalDiffAnnotation {
	return {
		filePath: annotation.filePath,
		side: annotationSide(annotation),
		lineNumber: Math.max(
			annotation.startLine ?? 1,
			annotation.endLine ?? annotation.startLine ?? 1,
		),
		metadata: { text: annotation.text },
	};
}

function forFile(file: FileDiffMetadata, annotations: LocalDiffAnnotation[]) {
	return annotations
		.filter((annotation) => !annotation.filePath || annotation.filePath === file.name)
		.map(({ filePath: _filePath, ...annotation }) => annotation);
}

export function FilesPage() {
	const editorRef = useRef<HTMLDivElement | null>(null);
	const noteRef = useRef<HTMLTextAreaElement>(null);
	const filesChatRef = useRef<HTMLTextAreaElement>(null);
	const [projectId, setProjectIdState] = useState(getSelectedProjectId("files"));
	const [worktreeId, setWorktreeIdState] = useState(getSelectedWorktreeId("files"));
	const [paths, setPaths] = useState<string[]>([]);
	const [file, setFile] = useState(initialState.file);
	const [content, setContent] = useState("");
	const [error, setError] = useState("");
	const [anchorLine, setAnchorLine] = useState<number | null>(initialState.anchorLine);
	const [endLine, setEndLine] = useState<number | null>(initialState.endLine);
	const [note, setNote] = useState(initialState.note);
	const [annotationMode, setAnnotationMode] = useState<"file" | "selection" | null>(initialState.annotationMode);
	const [annotations, setAnnotations] = useState<Annotation[]>([]);
	const [viewMode, setViewMode] = useState<ViewMode>(initialState.viewMode);
	const [diffPatches, setDiffPatches] = useState<DiffPatches>({
		committed: "",
		staged: "",
		unstaged: "",
	});
	const [selectedDiff, setSelectedDiff] = useState<SelectedLineRange | null>(initialState.selectedDiff);
	const [selectedDiffFile, setSelectedDiffFile] = useState(initialState.selectedDiffFile);
	const [comment, setComment] = useState(initialState.comment);
	const [localDiffAnnotations, setLocalDiffAnnotations] = useState<LocalDiffAnnotation[]>([]);
	const [filesMessage, setFilesMessage] = useState(initialState.filesMessage);
	const [filesChatAgentId, setFilesChatAgentId] = useState(initialState.filesChatAgentId);
	const [filesChatRun, setFilesChatRun] = useState<AgentRun | null>(null);
	const [filesChatStatus, setFilesChatStatus] = useState("");
	const [treeLoading, setTreeLoading] = useState(false);
	const [fileLoading, setFileLoading] = useState(false);
	const [diffLoading, setDiffLoading] = useState(false);
	const [annotationSaving, setAnnotationSaving] = useState(false);
	const [diffSaving, setDiffSaving] = useState(false);
	const [chatSending, setChatSending] = useState(false);
	const lines = useMemo(() => content.split("\n"), [content]);
	const selectedStart = anchorLine && endLine ? Math.min(anchorLine, endLine) : anchorLine;
	const selectedEnd = anchorLine && endLine ? Math.max(anchorLine, endLine) : anchorLine;
	const fileAnnotations = annotations.filter((a) => a.filePath === file);
	const wholeFileAnnotations = fileAnnotations.filter((a) => a.kind === "file");
	const lineFileAnnotations = fileAnnotations.filter((a) => a.kind !== "file");
	const diffSections = useMemo(
		() => [
			{
				id: "committed" as const,
				title: "Committed (main..HEAD)",
				patch: diffPatches.committed,
				files: parseDiffFiles(diffPatches.committed),
				fallbackFiles: diffFiles(diffPatches.committed),
			},
			{
				id: "staged" as const,
				title: "Not committed — staged",
				patch: diffPatches.staged,
				files: parseDiffFiles(diffPatches.staged),
				fallbackFiles: diffFiles(diffPatches.staged),
			},
			{
				id: "unstaged" as const,
				title: "Not committed — unstaged",
				patch: diffPatches.unstaged,
				files: parseDiffFiles(diffPatches.unstaged),
				fallbackFiles: diffFiles(diffPatches.unstaged),
			},
		],
		[diffPatches],
	);
	const changedPaths = useMemo(() => {
		const names = diffSections.flatMap((section) =>
			section.files.length
				? section.files.map((file) => file.name)
				: section.fallbackFiles,
		);
		return [...new Set(names)].filter((path): path is string => Boolean(path));
	}, [diffSections]);
	const treePaths = viewMode === "diff" ? changedPaths : paths;
	const renderedDiffAnnotations = useMemo(
		() => [...annotations.map(toDiffAnnotation), ...localDiffAnnotations],
		[annotations, localDiffAnnotations],
	);

	async function loadAnnotations(id = worktreeId) {
		if (id) setAnnotations(await apiGet<Annotation[]>(`/annotations?worktreeId=${id}`));
		else setAnnotations([]);
	}
	async function loadTree(id = worktreeId) {
		if (!id) {
			setPaths([]);
			setError("Select worktree.");
			return;
		}
		setTreeLoading(true);
		try {
			const nextPaths = await apiGet<string[]>(`/files/tree?worktreeId=${id}`);
			setPaths(nextPaths);
			await loadAnnotations(id);
			const savedFile = file || localStorage.getItem(`aware-open-file:${id}`) || "";
			if (savedFile && nextPaths.includes(savedFile)) await readFile(savedFile, id, viewMode !== "diff");
			else if (savedFile) {
				setFile("");
				setContent("");
				setPageState("files", { file: "", annotationMode: null });
			}
			setError("");
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setTreeLoading(false);
		}
	}
	async function loadDiffs(id = worktreeId) {
		if (!id) return;
		setDiffLoading(true);
		try {
		const fetchPatch = (mode: "main" | "staged" | "unstaged") =>
			fetch(`/api/diffs/git?${new URLSearchParams({ worktreeId: id, mode })}`).then(
				(r) => r.text(),
			);
		const [committed, staged, unstaged] = await Promise.all([
			fetchPatch("main"),
			fetchPatch("staged"),
			fetchPatch("unstaged"),
		]);
		setDiffPatches({ committed, staged, unstaged });
		setSelectedDiff(null);
		setSelectedDiffFile("");
		await loadAnnotations(id);
		} finally {
			setDiffLoading(false);
		}
	}
	useEffect(() => {
		void loadTree();
		void loadDiffs();
	}, []);
	useEffect(() => {
		if (!worktreeId) return;
		const source = new EventSource(`${API_BASE}/events/worktrees?${new URLSearchParams({ worktreeId })}`);
		const refreshCurrent = () => {
			if (!worktreeId) return;
			void loadTree(worktreeId);
			void loadDiffs(worktreeId);
			if (file) void readFile(file, worktreeId, viewMode !== "diff");
		};
		source.addEventListener("files", (event) => {
			const data = JSON.parse((event as MessageEvent<string>).data) as { worktreeId?: string };
			if (data.worktreeId === worktreeId) refreshCurrent();
		});
		source.addEventListener("worktrees", () => {
			window.dispatchEvent(new Event("aware:worktrees"));
			refreshCurrent();
		});
		return () => source.close();
	}, [worktreeId, file, viewMode]);
	useEffect(() => {
		if (annotationMode) noteRef.current?.focus();
	}, [annotationMode]);
	useEffect(() => {
		const input = filesChatRef.current;
		if (!input) return;
		input.style.height = "auto";
		input.style.height = `${input.scrollHeight}px`;
	}, [filesMessage]);

	function chooseProject(id: string) {
		setSelectedProjectId(id, "files");
		setProjectIdState(id);
		setWorktreeIdState("");
		setPaths([]);
		setFile("");
		setContent("");
		setPageState("files", { file: "", annotationMode: null, anchorLine: null, endLine: null });
		setDiffPatches({ committed: "", staged: "", unstaged: "" });
		setAnnotations([]);
	}
	function chooseWorktree(id: string) {
		setSelectedWorktreeId(id, "files");
		setWorktreeIdState(id);
		setFile("");
		setContent("");
		setPageState("files", { file: "", annotationMode: null, anchorLine: null, endLine: null });
		setDiffPatches({ committed: "", staged: "", unstaged: "" });
		void loadTree(id);
		void loadDiffs(id);
	}
	async function readFile(path: string, id = worktreeId, switchToFile = true) {
		if (!id) return;
		setFileLoading(true);
		try {
		const text = await fetch(`/api/files/read?worktreeId=${id}&path=${encodeURIComponent(path)}`).then((r) => r.text());
		localStorage.setItem(`aware-open-file:${id}`, path);
		setFile(path);
		setContent(text);
		setPageState("files", { file: path });
		if (switchToFile) {
			setViewMode("file");
			setPageState("files", { viewMode: "file", note: "" });
		}
		setAnchorLine(null);
		setEndLine(null);
		setNote("");
		setAnnotationMode(null);
		setPageState("files", { anchorLine: null, endLine: null, note: "", annotationMode: null });
		} finally {
			setFileLoading(false);
		}
	}
	function selectLine(line: number, extend: boolean) {
		if (extend && anchorLine) {
			setEndLine(line);
			setPageState("files", { endLine: line, annotationMode: "selection" });
		} else {
			setAnchorLine(line);
			setEndLine(line);
			setPageState("files", { anchorLine: line, endLine: line, annotationMode: "selection" });
		}
		setAnnotationMode("selection");
	}
	async function saveAnnotation(kind: "file" | "line" | "range") {
		if (!projectId || !worktreeId || !file || !note.trim() || annotationSaving) return;
		setAnnotationSaving(true);
		try {
		await apiPost<Annotation>("/annotations", {
			projectId,
			worktreeId,
			kind,
			filePath: file,
			startLine: kind === "file" ? undefined : (selectedStart ?? undefined),
			endLine: kind === "file" ? undefined : (selectedEnd ?? undefined),
			text: note,
			sent: false,
			status: "pending",
		});
		setNote("");
		setPageState("files", { note: "", anchorLine: null, endLine: null, annotationMode: null });
		setAnchorLine(null);
		setEndLine(null);
		setAnnotationMode(null);
		await loadAnnotations();
		} finally {
			setAnnotationSaving(false);
		}
	}
	function saveActiveAnnotation() {
		if (annotationMode === "file") return saveAnnotation("file");
		if (!selectedStart) return;
		return saveAnnotation(selectedStart === selectedEnd ? "line" : "range");
	}
	function selectDiffLines(fileName: string, range: SelectedLineRange | null) {
		setSelectedDiff(range);
		setSelectedDiffFile(range ? fileName : "");
		setPageState("files", { selectedDiff: range, selectedDiffFile: range ? fileName : "" });
	}
	function selectDiffLine(fileName: string, line: OnDiffLineClickProps) {
		selectDiffLines(fileName, {
			start: line.lineNumber,
			end: line.lineNumber,
			side: line.annotationSide,
			endSide: line.annotationSide,
		});
	}
	async function addDiffComment() {
		if (!projectId || !worktreeId || !selectedDiff || !comment.trim() || diffSaving) return;
		setDiffSaving(true);
		try {
		const side = selectedDiff.side === "deletions" ? "deletions" : "additions";
		setLocalDiffAnnotations((prev) => [
			...prev,
			{ filePath: selectedDiffFile, side, lineNumber: Math.max(selectedDiff.start, selectedDiff.end), metadata: { text: comment } },
		]);
		await apiPost("/annotations", {
			projectId,
			worktreeId,
			taskId: getSelection().selectedTaskId || undefined,
			kind: "diff",
			filePath: selectedDiffFile || undefined,
			side,
			startLine: selectedDiff.start,
			endLine: selectedDiff.end,
			text: comment.trim(),
			sent: false,
		});
		setSelectedDiff(null);
		setSelectedDiffFile("");
		setComment("");
		setPageState("files", { comment: "", selectedDiff: null, selectedDiffFile: "" });
		await loadAnnotations();
		} finally {
			setDiffSaving(false);
		}
	}
	async function sendFilesChat() {
		if (!projectId || !worktreeId || !filesMessage.trim() || chatSending) return;
		setChatSending(true);
		try {
			setFilesChatStatus("starting agent run...");
			setPageState("files", { filesMessage, filesChatAgentId });
			const run = await apiPost<AgentRun>("/chat", {
				projectId,
				worktreeId,
				agentProfileId: filesChatAgentId,
				message: filesMessage,
				annotationIds: [],
			});
			setFilesMessage("");
			setPageState("files", { filesMessage: "" });
			setFilesChatRun(run);
			setFilesChatStatus(`run ${run.id} ${run.status}`);
		} finally {
			setChatSending(false);
		}
	}
	function openFilesChatRun(run: AgentRun) {
		setFilesChatRun(null);
		setFilesChatStatus("");
		setSelectedRunId(run.id);
	}

	return (
		<section id="files" className="files-page full-workspace">
			<aside className="project-worktree-sidebar">
				<ProjectColumn value={projectId} onChange={chooseProject} />
				<WorktreeColumn projectId={projectId} value={worktreeId} onChange={chooseWorktree} />
			</aside>
			<div className="files-main">
				<div className="files-file-row">
			<section className="card tree-pane">
				<div className="panel-head"><h2>{viewMode === "diff" ? "Changed Files" : "File Tree"}</h2>{treeLoading || diffLoading ? <BusyIndicator label={viewMode === "diff" ? "Loading diffs" : "Loading tree"} /> : null}</div>
				{error ? <p className="error">{error}</p> : null}
				{treePaths.length ? <FileTreeView paths={treePaths} selectedPath={file} onOpen={(path) => void readFile(path, worktreeId, viewMode !== "diff")} /> : <p>{viewMode === "diff" ? "No changed files." : "Select worktree to load tree."}</p>}
			</section>
			<section className="card editor-pane files-view-pane" ref={editorRef}>
				<div className="panel-head files-view-head">
					<div>
						<h2>{viewMode === "file" ? file || "Open file" : file ? `Diffs: ${file}` : "Diffs"}</h2>
					</div>
					<div className="segmented-actions">
						<button type="button" className={viewMode === "file" ? "active" : ""} onClick={() => { setViewMode("file"); setPageState("files", { viewMode: "file" }); }}>File</button>
						<button type="button" className={viewMode === "diff" ? "active" : ""} onClick={() => { setViewMode("diff"); setPageState("files", { viewMode: "diff" }); void loadDiffs(); }}>Diff</button>
						{file ? <button type="button" onClick={() => { setNote(""); setAnnotationMode("file"); setPageState("files", { note: "", annotationMode: "file" }); }}>Annotate file</button> : null}
					</div>
				</div>
				{annotationMode ? (
					<div className="annotation-popover">
						<div className="panel-head"><strong>{annotationMode === "file" ? "Annotate file" : `Annotate lines ${selectedStart}-${selectedEnd}`}</strong><button type="button" onClick={() => { setAnnotationMode(null); setPageState("files", { annotationMode: null }); }}>×</button></div>
						<textarea ref={noteRef} value={note} onChange={(e) => { setNote(e.target.value); setPageState("files", { note: e.target.value }); }} placeholder="Write annotation. Cmd+Enter saves." onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void saveActiveAnnotation(); } }} />
						<div className="popover-actions"><button type="button" disabled={!note.trim() || annotationSaving} onClick={() => void saveActiveAnnotation()}>{annotationSaving ? "Saving…" : "Save"}</button><button type="button" disabled={annotationSaving} onClick={() => { setAnnotationMode(null); setPageState("files", { annotationMode: null }); }}>Cancel</button></div>
					</div>
				) : null}
				{viewMode === "file" ? (
					<>
						{wholeFileAnnotations.map((a) => <div key={a.id} className={`inline-annotation ${a.status === "processing" ? "processing" : ""}`}><strong>File note:</strong> {a.text}{a.runId ? <> <RunLink runId={a.runId} /></> : null}</div>)}
						{fileLoading ? <BusyIndicator label="Loading file" /> : null}
						<div className="code-lines">
							{file ? lines.map((line, i) => {
								const n = i + 1;
								const selected = selectedStart && selectedEnd && n >= selectedStart && n <= selectedEnd;
								const rowAnnotations = lineFileAnnotations.filter((a) => a.startLine && n === (a.endLine ?? a.startLine));
								return <div key={`${file}-${n}`}><button type="button" className={`code-line ${selected ? "selected" : ""}`} onClick={(e) => selectLine(n, e.shiftKey)}><span className="line-no">{n}</span><code>{line || " "}</code></button>{rowAnnotations.map((a) => <div key={a.id} className={`inline-annotation ${a.status === "processing" ? "processing" : ""}`}>{a.text}{a.runId ? <> <RunLink runId={a.runId} /></> : null}</div>)}</div>;
							}) : <p>Open file from tree.</p>}
						</div>
					</>
				) : (
					<div className="files-diff-view">
						{selectedDiff ? (
							<div className="annotation-popover diff-annotation-popover">
								<div className="panel-head"><strong>Annotate {selectedDiffFile}:{selectedDiff.start}-{selectedDiff.end}</strong><button type="button" onClick={() => selectDiffLines("", null)}>×</button></div>
								<textarea value={comment} onChange={(e) => { setComment(e.target.value); setPageState("files", { comment: e.target.value }); }} placeholder="Comment on selected diff lines. Cmd+Enter saves." onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void addDiffComment(); } }} />
								<div className="popover-actions"><button type="button" disabled={!comment.trim() || diffSaving} onClick={() => void addDiffComment()}>{diffSaving ? "Saving…" : "Save"}</button><button type="button" disabled={diffSaving} onClick={() => selectDiffLines("", null)}>Cancel</button></div>
							</div>
						) : <p className="diff-help-text">Click diff line to annotate.</p>}
						{diffLoading ? <BusyIndicator label="Loading diffs" /> : null}
						<div className="files-diff-scroll">
							{diffSections.some((section) => section.patch) ? diffSections.map((section) => {
								const visibleFiles = file
									? section.files.filter((diffFile) => diffFile.name === file || diffFile.prevName === file)
									: section.files;
								return (
								<section key={section.id} className="diff-section">
									<h3>{section.title}</h3>
									{visibleFiles.length ? visibleFiles.map((diffFile) => <FileDiff key={`${section.id}-${diffFile.name}-${diffFile.prevName ?? ""}`} fileDiff={diffFile} disableWorkerPool selectedLines={selectedDiffFile === diffFile.name ? selectedDiff : null} lineAnnotations={forFile(diffFile, renderedDiffAnnotations)} renderAnnotation={(a) => <div className="annotation">{a.metadata.text}</div>} options={{ enableLineSelection: true, onLineClick: (line) => selectDiffLine(diffFile.name, line), onLineNumberClick: (line) => selectDiffLine(diffFile.name, line), onLineSelectionEnd: (range) => selectDiffLines(diffFile.name, range) }} />) : section.patch ? <p className="empty-state">{file ? "No changes for opened file in this section." : "No changes."}</p> : <p className="empty-state">No changes.</p>}
								</section>
							)}) : <pre>No diff loaded</pre>}
						</div>
					</div>
				)}
				<div className="files-chat files-chat-inline">
					<textarea ref={filesChatRef} rows={1} value={filesMessage} onChange={(e) => { setFilesMessage(e.target.value); setPageState("files", { filesMessage: e.target.value }); }} placeholder="Chat about these files/worktree." />
					<div className="files-chat-actions"><AgentPicker value={filesChatAgentId} onChange={(id) => { setFilesChatAgentId(id); setPageState("files", { filesChatAgentId: id }); }} />{chatSending ? <BusyIndicator label="Starting" /> : null}<button type="button" disabled={!filesMessage.trim() || chatSending} onClick={() => void sendFilesChat()}>{chatSending ? "Sending…" : "Send"}</button>{filesChatStatus ? <p>{filesChatStatus}{filesChatRun ? <> — <a href="#runs" onClick={() => openFilesChatRun(filesChatRun)}>open run</a></> : null}</p> : null}</div>
				</div>
			</section>
				</div>
				<section className="card files-annotations-row">
					<AnnotationsPanel annotations={viewMode === "file" && file ? fileAnnotations : annotations} projectId={projectId} worktreeId={worktreeId} onRefresh={loadAnnotations} />
				</section>
			</div>
		</section>
	);
}
