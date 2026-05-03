import type { AgentRun, Annotation } from "@aware/shared";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost } from "../app/api";
import { getSelection, setSelectedRunId } from "../app/selection";
import { AgentPicker } from "../components/AgentPicker";
import { AnnotationsPanel } from "../components/AnnotationsPanel";
import { RunLink } from "../components/RunLink";

function directoryPaths(paths: string[]) {
	const dirs = new Set<string>();
	for (const path of paths) {
		const parts = path.split("/").filter(Boolean);
		const limit = path.endsWith("/") ? parts.length : parts.length - 1;
		for (let i = 1; i <= limit; i += 1) {
			dirs.add(`${parts.slice(0, i).join("/")}/`);
		}
	}
	return [...dirs];
}

function oneDepthDirectoryPaths(paths: string[]) {
	return directoryPaths(paths).filter((path) => path.slice(0, -1).includes("/") === false);
}

function fzfScore(path: string, query: string) {
	const haystack = path.toLowerCase();
	const needle = query.toLowerCase().replace(/\s+/g, "");
	if (!needle) return 0;
	let score = 0;
	let lastIndex = -1;
	for (const char of needle) {
		const index = haystack.indexOf(char, lastIndex + 1);
		if (index === -1) return null;
		score += index === lastIndex + 1 ? 3 : 1;
		if (index === 0 || "/-_ .".includes(haystack[index - 1] ?? "")) score += 2;
		lastIndex = index;
	}
	return score - haystack.length / 1000;
}

function fzfFilterPaths(paths: string[], query: string) {
	const trimmed = query.trim();
	if (!trimmed) return paths;
	return paths
		.map((path) => ({ path, score: fzfScore(path, trimmed) }))
		.filter((entry): entry is { path: string; score: number } => entry.score !== null)
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.map((entry) => entry.path);
}

function Tree({
	paths,
	onOpen,
}: {
	paths: string[];
	onOpen: (path: string) => void;
}) {
	const [searchQuery, setSearchQuery] = useState("");
	const [expansion, setExpansion] = useState<"one" | "none" | "all">("one");
	const onOpenRef = useRef(onOpen);
	onOpenRef.current = onOpen;
	const visiblePaths = useMemo(
		() => fzfFilterPaths(paths, searchQuery),
		[paths, searchQuery],
	);
	const expandedPaths = useMemo(() => {
		if (expansion === "none") return [];
		if (expansion === "all" || searchQuery.trim()) return directoryPaths(visiblePaths);
		return oneDepthDirectoryPaths(visiblePaths);
	}, [expansion, searchQuery, visiblePaths]);
	const { model } = useFileTree({
		paths: visiblePaths,
		search: false,
		initialExpansion: 1,
		initialExpandedPaths: expandedPaths,
		onSelectionChange: (selectedPaths) => {
			const selected = selectedPaths.find((path) => !path.endsWith("/"));
			if (selected) onOpenRef.current(selected);
		},
	});
	useEffect(() => {
		model.resetPaths(visiblePaths, { initialExpandedPaths: expandedPaths });
	}, [expandedPaths, model, visiblePaths]);
	return (
		<FileTree
			id="file-tree-host"
			model={model}
			header={
				<div className="file-tree-header">
					<div className="file-tree-actions">
						<button type="button" onClick={() => setExpansion("none")}>
							Collapse all
						</button>
						<button type="button" onClick={() => setExpansion("all")}>
							Expand all
						</button>
					</div>
					<input
						type="search"
						value={searchQuery}
						onChange={(event) => setSearchQuery(event.target.value)}
						placeholder="fzf search files"
						aria-label="fzf search files"
					/>
				</div>
			}
			style={{ height: "100%" }}
		/>
	);
}

export function FilesPage() {
	const [paths, setPaths] = useState<string[]>([]);
	const [file, setFile] = useState("");
	const [content, setContent] = useState("");
	const [error, setError] = useState("");
	const [anchorLine, setAnchorLine] = useState<number | null>(null);
	const [endLine, setEndLine] = useState<number | null>(null);
	const [note, setNote] = useState("");
	const [annotationMode, setAnnotationMode] = useState<
		"file" | "selection" | null
	>(null);
	const [projectMessage, setProjectMessage] = useState("");
	const [projectChatAgentId, setProjectChatAgentId] = useState("");
	const [projectChatRun, setProjectChatRun] = useState<AgentRun | null>(null);
	const [projectChatStatus, setProjectChatStatus] = useState("");
	const [annotations, setAnnotations] = useState<Annotation[]>([]);
	const loadedWorktreeId = useRef("");
	const noteRef = useRef<HTMLTextAreaElement>(null);
	const projectChatRef = useRef<HTMLTextAreaElement>(null);
	const lines = useMemo(() => content.split("\n"), [content]);
	const fileAnnotations = annotations.filter((a) => a.filePath === file);
	const wholeFileAnnotations = fileAnnotations.filter((a) => a.kind === "file");
	const lineFileAnnotations = fileAnnotations.filter((a) => a.kind !== "file");
	const selectedStart =
		anchorLine && endLine ? Math.min(anchorLine, endLine) : anchorLine;
	const selectedEnd =
		anchorLine && endLine ? Math.max(anchorLine, endLine) : anchorLine;

	async function loadAnnotations() {
		const id = getSelection().selectedWorktreeId;
		if (id)
			setAnnotations(
				await apiGet<Annotation[]>(`/annotations?worktreeId=${id}`),
			);
	}
	useEffect(() => {
		async function loadTree(force = false) {
			const id = getSelection().selectedWorktreeId;
			if (!id) {
				setPaths([]);
				setError("Select project + worktree at top first.");
				loadedWorktreeId.current = "";
				return;
			}
			if (!force && loadedWorktreeId.current === id) return;
			loadedWorktreeId.current = id;
			try {
				setPaths(await apiGet<string[]>(`/files/tree?worktreeId=${id}`));
				await loadAnnotations();
				const savedFile = localStorage.getItem(`aware-open-file:${id}`);
				if (savedFile) await read(savedFile);
				setError("");
			} catch (error) {
				setError(error instanceof Error ? error.message : String(error));
			}
		}
		void loadTree(true);
		const onSelection = () => void loadTree(false);
		window.addEventListener("aware-selection", onSelection);
		return () => window.removeEventListener("aware-selection", onSelection);
	}, []);
	useEffect(() => {
		if (annotationMode) noteRef.current?.focus();
	}, [annotationMode]);
	useEffect(() => {
		const input = projectChatRef.current;
		if (!input) return;
		input.style.height = "auto";
		input.style.height = `${input.scrollHeight}px`;
	}, [projectMessage]);

	async function read(path: string) {
		const id = getSelection().selectedWorktreeId;
		const text = await fetch(
			`/api/files/read?worktreeId=${id}&path=${encodeURIComponent(path)}`,
		).then((r) => r.text());
		if (id) localStorage.setItem(`aware-open-file:${id}`, path);
		setFile(path);
		setContent(text);
		setAnchorLine(null);
		setEndLine(null);
		setNote("");
		setAnnotationMode(null);
	}
	function selectLine(line: number, extend: boolean) {
		if (extend && anchorLine) setEndLine(line);
		else {
			setAnchorLine(line);
			setEndLine(line);
		}
		if (annotationMode !== "selection") setNote("");
		setAnnotationMode("selection");
	}
	async function saveAnnotation(kind: "file" | "line" | "range") {
		const { selectedProjectId, selectedWorktreeId } = getSelection();
		if (!selectedWorktreeId || !file || !note.trim()) return;
		const body = {
			projectId: selectedProjectId || "local",
			worktreeId: selectedWorktreeId,
			kind,
			filePath: file,
			startLine: kind === "file" ? undefined : (selectedStart ?? undefined),
			endLine: kind === "file" ? undefined : (selectedEnd ?? undefined),
			text: note,
			sent: false,
			status: "pending",
		};
		await apiPost<Annotation>("/annotations", body);
		setNote("");
		setAnchorLine(null);
		setEndLine(null);
		setAnnotationMode(null);
		await loadAnnotations();
	}
	function saveActiveAnnotation() {
		if (annotationMode === "file") return saveAnnotation("file");
		if (!selectedStart) return;
		return saveAnnotation(selectedStart === selectedEnd ? "line" : "range");
	}
	async function sendProjectChat() {
		const { selectedProjectId, selectedWorktreeId } = getSelection();
		if (!selectedWorktreeId || !projectMessage.trim()) return;
		setProjectChatStatus("starting agent run...");
		const run = await apiPost<AgentRun>("/chat", {
			projectId: selectedProjectId,
			worktreeId: selectedWorktreeId,
			agentProfileId: projectChatAgentId,
			message: projectMessage,
			annotationIds: [],
		});
		setProjectMessage("");
		setProjectChatRun(run);
		setProjectChatStatus(`run ${run.id} ${run.status}`);
	}
	function openProjectChatRun(run: AgentRun) {
		setProjectMessage("");
		setProjectChatRun(null);
		setProjectChatStatus("");
		setSelectedRunId(run.id);
	}
	return (
		<section id="files" className="three-pane full-workspace files-workspace">
			<div className="card tree-pane">
				<h2>Files</h2>
				{error ? <p className="error">{error}</p> : null}
				{paths.length ? (
					<Tree paths={paths} onOpen={read} />
				) : (
					<p>Select worktree at top to load tree.</p>
				)}
			</div>
			<div className="card editor-pane">
				<div className="panel-head">
					<h2>{file || "Open file"}</h2>
					{file ? (
						<button
							type="button"
							className="annotate-file-button"
							onClick={() => {
								setNote("");
								setAnnotationMode("file");
							}}
						>
							Annotate file
						</button>
					) : null}
				</div>
				{annotationMode ? (
					<div className="annotation-popover">
						<div className="panel-head">
							<strong>
								{annotationMode === "file"
									? "Annotate file"
									: selectedStart
										? `Annotate lines ${selectedStart}-${selectedEnd}`
										: "Annotate selection"}
							</strong>
							<button
								type="button"
								onClick={() => {
									setNote("");
									setAnnotationMode(null);
								}}
							>
								×
							</button>
						</div>
						<textarea
							ref={noteRef}
							value={note}
							onChange={(e) => setNote(e.target.value)}
							onKeyDown={(e) => {
								if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
									e.preventDefault();
									void saveActiveAnnotation();
								}
							}}
							placeholder="Write annotation. Cmd+Enter saves."
						/>
						<div className="popover-actions">
							<button
								type="button"
								disabled={
									!note.trim() ||
									(annotationMode === "selection" && !selectedStart)
								}
								onClick={() => void saveActiveAnnotation()}
							>
								Save
							</button>
							<button
								type="button"
								onClick={() => {
									setNote("");
									setAnchorLine(null);
									setEndLine(null);
									setAnnotationMode(null);
								}}
							>
								Cancel
							</button>
						</div>
					</div>
				) : null}
				{wholeFileAnnotations.map((a) => (
					<div
						key={a.id}
						className={`inline-annotation ${a.status === "processing" ? "processing" : ""}`}
					>
						<strong>File note:</strong> {a.text}
						{a.runId ? (
							<>
								{" "}
								<RunLink runId={a.runId} />
							</>
						) : null}
					</div>
				))}
				<div className="code-lines">
					{lines.map((line, i) => {
						const n = i + 1;
						const selected =
							selectedStart &&
							selectedEnd &&
							n >= selectedStart &&
							n <= selectedEnd;
						const lineAnnotations = lineFileAnnotations.filter((a) => {
							if (!a.startLine) return false;
							const end = a.endLine ?? a.startLine;
							return n === end;
						});
						return (
							<div key={`${file}-${n}`}>
								<button
									type="button"
									className={`code-line ${selected ? "selected" : ""}`}
									onClick={(e) => selectLine(n, e.shiftKey)}
								>
									<span className="line-no">{n}</span>
									<code>{line || " "}</code>
								</button>
								{lineAnnotations.map((a) => (
									<div
										key={a.id}
										className={`inline-annotation ${a.status === "processing" ? "processing" : ""}`}
									>
										{a.text}
										{a.runId ? (
											<>
												{" "}
												<RunLink runId={a.runId} />
											</>
										) : null}
									</div>
								))}
							</div>
						);
					})}
				</div>
			</div>
			<div className="annotation-pane">
				<AnnotationsPanel
					annotations={file ? fileAnnotations : annotations}
					onRefresh={loadAnnotations}
				/>
			</div>
			<div className="card files-project-chat">
				<textarea
					ref={projectChatRef}
					rows={1}
					value={projectMessage}
					onChange={(e) => setProjectMessage(e.target.value)}
					onKeyDown={(e) => {
						if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
							e.preventDefault();
							void sendProjectChat();
						}
					}}
					placeholder="Chat about this project/worktree. No annotations, tasks, or diffs included."
				/>
				<div className="files-project-chat-actions">
					<AgentPicker
						value={projectChatAgentId}
						onChange={setProjectChatAgentId}
					/>
					<button
						type="button"
						disabled={!projectMessage.trim()}
						onClick={() => void sendProjectChat()}
					>
						Send
					</button>
					{projectChatStatus ? (
						<p>
							{projectChatStatus}
							{projectChatRun ? (
								<>
									{" — "}
									<a
										href="#runs"
										onClick={() => openProjectChatRun(projectChatRun)}
									>
										open run
									</a>
								</>
							) : null}
						</p>
					) : null}
				</div>
			</div>
		</section>
	);
}
