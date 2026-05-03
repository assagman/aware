import type { AgentRun, Annotation } from "@aware/shared";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost } from "../app/api";
import {
	getPageState,
	persistScroll,
	restoreScroll,
	setPageState,
} from "../app/pageState";
import {
	getSelectedWorktreeId,
	getSelection,
	setSelectedRunId,
	setSelectedWorktreeId,
} from "../app/selection";
import { AgentPicker } from "../components/AgentPicker";
import { AnnotationsPanel } from "../components/AnnotationsPanel";
import { RunLink } from "../components/RunLink";
import { WorktreeSelect } from "../components/WorktreeSelect";

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
	return directoryPaths(paths).filter(
		(path) => path.slice(0, -1).includes("/") === false,
	);
}

function fzfMatch(text: string, query: string) {
	const haystack = text.toLowerCase();
	const needle = query.toLowerCase().replace(/\s+/g, "");
	if (!needle) return { indexes: new Set<number>(), score: 0 };
	const indexes = new Set<number>();
	let score = 0;
	let lastIndex = -1;
	for (const char of needle) {
		const index = haystack.indexOf(char, lastIndex + 1);
		if (index === -1) return null;
		indexes.add(index);
		score += index === lastIndex + 1 ? 3 : 1;
		if (index === 0 || "/-_ .".includes(haystack[index - 1] ?? "")) score += 2;
		lastIndex = index;
	}
	return { indexes, score: score - haystack.length / 1000 };
}

function fzfScore(path: string, query: string) {
	return fzfMatch(path, query)?.score ?? null;
}

function fzfFilterPaths(paths: string[], query: string) {
	const trimmed = query.trim();
	if (!trimmed) return paths;
	return paths
		.map((path) => ({ path, score: fzfScore(path, trimmed) }))
		.filter(
			(entry): entry is { path: string; score: number } => entry.score !== null,
		)
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.map((entry) => entry.path);
}

function clearTreeSearchHighlights(root: ParentNode) {
	for (const match of Array.from(root.querySelectorAll(".aware-fzf-match"))) {
		const parent = match.parentNode;
		if (!parent) continue;
		parent.replaceChild(document.createTextNode(match.textContent ?? ""), match);
		parent.normalize();
	}
}

function highlightTextNode(node: Text, query: string) {
	const text = node.nodeValue ?? "";
	const indexes = fzfMatch(text, query)?.indexes;
	if (!indexes?.size) return;
	const fragment = document.createDocumentFragment();
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index] ?? "";
		if (indexes.has(index)) {
			const span = document.createElement("span");
			span.className = "aware-fzf-match";
			span.textContent = char;
			fragment.appendChild(span);
		} else {
			fragment.appendChild(document.createTextNode(char));
		}
	}
	node.parentNode?.replaceChild(fragment, node);
}

function applyTreeSearchHighlights(root: ParentNode, query: string) {
	clearTreeSearchHighlights(root);
	const trimmed = query.trim();
	if (!trimmed) return;
	const containers = root.querySelectorAll(
		"[data-item-section='content'] [data-truncate-content], [data-item-flattened-subitem] [data-truncate-content], [data-item-section='content']",
	);
	for (const container of Array.from(containers)) {
		if (!(container instanceof HTMLElement)) continue;
		if (
			container.matches("[data-item-section='content']") &&
			container.querySelector("[data-truncate-content]")
		) {
			continue;
		}
		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
		const textNodes: Text[] = [];
		while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
		for (const textNode of textNodes) highlightTextNode(textNode, trimmed);
	}
}

function Tree({
	paths,
	onOpen,
}: {
	paths: string[];
	onOpen: (path: string) => void;
}) {
	const initialTree = getPageState("files-tree", {
		searchQuery: "",
		expansion: "one" as "one" | "none" | "all",
	});
	const [searchQuery, setSearchQuery] = useState(initialTree.searchQuery);
	const [expansion, setExpansion] = useState<"one" | "none" | "all">(
		initialTree.expansion,
	);
	const onOpenRef = useRef(onOpen);
	const searchInputRef = useRef<HTMLInputElement>(null);
	onOpenRef.current = onOpen;
	const visiblePaths = useMemo(
		() => fzfFilterPaths(paths, searchQuery),
		[paths, searchQuery],
	);
	const expandedPaths = useMemo(() => {
		if (expansion === "none") return [];
		if (expansion === "all" || searchQuery.trim())
			return directoryPaths(visiblePaths);
		return oneDepthDirectoryPaths(visiblePaths);
	}, [expansion, searchQuery, visiblePaths]);
	const { model } = useFileTree({
		paths: visiblePaths,
		search: false,
		initialExpansion: 1,
		initialExpandedPaths: expandedPaths,
		unsafeCSS: `
			.aware-fzf-match {
				color: #f59e0b;
				font-weight: 700;
			}
		`,
		onSelectionChange: (selectedPaths) => {
			const selected = selectedPaths.find((path) => !path.endsWith("/"));
			if (selected) onOpenRef.current(selected);
		},
	});
	useEffect(() => {
		const input = searchInputRef.current;
		const hadSearchFocus = document.activeElement === input;
		const selectionStart = input?.selectionStart ?? null;
		const selectionEnd = input?.selectionEnd ?? null;
		model.resetPaths(visiblePaths, { initialExpandedPaths: expandedPaths });
		if (hadSearchFocus) {
			window.requestAnimationFrame(() => {
				input?.focus({ preventScroll: true });
				if (selectionStart !== null && selectionEnd !== null) {
					input?.setSelectionRange(selectionStart, selectionEnd);
				}
			});
		}
	}, [expandedPaths, model, visiblePaths]);
	useEffect(() => {
		const host = document.getElementById("file-tree-host");
		const shadowRoot = host?.shadowRoot;
		if (!shadowRoot) return;
		let frame = 0;
		const observer = new MutationObserver(() => refresh());
		const observe = () =>
			observer.observe(shadowRoot, {
				childList: true,
				subtree: true,
			});
		const refresh = () => {
			window.cancelAnimationFrame(frame);
			frame = window.requestAnimationFrame(() => {
				observer.disconnect();
				applyTreeSearchHighlights(shadowRoot, searchQuery);
				observe();
			});
		};
		refresh();
		observe();
		return () => {
			window.cancelAnimationFrame(frame);
			observer.disconnect();
			clearTreeSearchHighlights(shadowRoot);
		};
	}, [searchQuery, visiblePaths]);
	return (
		<FileTree
			id="file-tree-host"
			model={model}
			header={
				<div className="file-tree-header">
					<div className="file-tree-actions">
						<button
							type="button"
							onClick={() => {
								setExpansion("none");
								setPageState("files-tree", { expansion: "none" });
							}}
						>
							Collapse all
						</button>
						<button
							type="button"
							onClick={() => {
								setExpansion("all");
								setPageState("files-tree", { expansion: "all" });
							}}
						>
							Expand all
						</button>
					</div>
					<input
						ref={searchInputRef}
						type="search"
						value={searchQuery}
						onChange={(event) => {
							setSearchQuery(event.target.value);
							setPageState("files-tree", { searchQuery: event.target.value });
						}}
						placeholder="fzf search files"
						aria-label="fzf search files"
					/>
				</div>
			}
			style={{ height: "100%" }}
		/>
	);
}

const initialFilesState = getPageState("files", {
	note: "",
	projectMessage: "",
	projectChatAgentId: "",
});

export function FilesPage() {
	const editorRef = useRef<HTMLDivElement | null>(null);
	const [worktreeId, setWorktreeId] = useState(getSelectedWorktreeId("files"));
	const [paths, setPaths] = useState<string[]>([]);
	const [file, setFile] = useState("");
	const [content, setContent] = useState("");
	const [error, setError] = useState("");
	const [anchorLine, setAnchorLine] = useState<number | null>(null);
	const [endLine, setEndLine] = useState<number | null>(null);
	const [note, setNote] = useState(initialFilesState.note);
	const [annotationMode, setAnnotationMode] = useState<
		"file" | "selection" | null
	>(null);
	const [projectMessage, setProjectMessage] = useState(
		initialFilesState.projectMessage,
	);
	const [projectChatAgentId, setProjectChatAgentId] = useState(
		initialFilesState.projectChatAgentId,
	);
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

	async function loadAnnotations(id = worktreeId) {
		if (id)
			setAnnotations(
				await apiGet<Annotation[]>(`/annotations?worktreeId=${id}`),
			);
	}
	useEffect(() => {
		async function loadTree(force = false, nextId = worktreeId) {
			const id = nextId;
			if (!id) {
				setPaths([]);
				setError("Select worktree first.");
				loadedWorktreeId.current = "";
				return;
			}
			if (!force && loadedWorktreeId.current === id) return;
			loadedWorktreeId.current = id;
			try {
				setPaths(await apiGet<string[]>(`/files/tree?worktreeId=${id}`));
				await loadAnnotations(id);
				const savedFile = localStorage.getItem(`aware-open-file:${id}`);
				if (savedFile) await read(savedFile, id);
				setError("");
			} catch (error) {
				setError(error instanceof Error ? error.message : String(error));
			}
		}
		void loadTree(true);
		const onSelection = () => {
			const nextId = getSelectedWorktreeId("files");
			setWorktreeId(nextId);
			void loadTree(false, nextId);
		};
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

	function chooseWorktree(id: string) {
		setSelectedWorktreeId(id, "files");
		setWorktreeId(id);
		setFile("");
		setContent("");
		loadedWorktreeId.current = "";
	}

	async function read(path: string, nextId = worktreeId) {
		const id = nextId;
		const text = await fetch(
			`/api/files/read?worktreeId=${id}&path=${encodeURIComponent(path)}`,
		).then((r) => r.text());
		if (id) localStorage.setItem(`aware-open-file:${id}`, path);
		setFile(path);
		setContent(text);
		window.requestAnimationFrame(() =>
			restoreScroll("files-editor-scroll", editorRef.current),
		);
		setAnchorLine(null);
		setEndLine(null);
		setNote("");
		setPageState("files", { note: "" });
		setAnnotationMode(null);
	}
	function selectLine(line: number, extend: boolean) {
		if (extend && anchorLine) setEndLine(line);
		else {
			setAnchorLine(line);
			setEndLine(line);
		}
		if (annotationMode !== "selection") {
			setNote("");
			setPageState("files", { note: "" });
		}
		setAnnotationMode("selection");
	}
	async function saveAnnotation(kind: "file" | "line" | "range") {
		const { selectedProjectId } = getSelection();
		if (!worktreeId || !file || !note.trim()) return;
		const body = {
			projectId: selectedProjectId || "local",
			worktreeId,
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
		setPageState("files", { note: "" });
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
		const { selectedProjectId } = getSelection();
		if (!worktreeId || !projectMessage.trim()) return;
		setProjectChatStatus("starting agent run...");
		setPageState("files", {
			projectMessage,
			projectChatAgentId,
		});
		const run = await apiPost<AgentRun>("/chat", {
			projectId: selectedProjectId,
			worktreeId,
			agentProfileId: projectChatAgentId,
			message: projectMessage,
			annotationIds: [],
		});
		setProjectMessage("");
		setPageState("files", { projectMessage: "" });
		setProjectChatRun(run);
		setProjectChatStatus(`run ${run.id} ${run.status}`);
	}
	function openProjectChatRun(run: AgentRun) {
		setProjectMessage("");
		setPageState("files", { projectMessage: "" });
		setProjectChatRun(null);
		setProjectChatStatus("");
		setSelectedRunId(run.id);
	}
	return (
		<section id="files" className="three-pane full-workspace files-workspace">
			<div className="card tree-pane">
				<div className="panel-head">
					<h2>Files</h2>
					<WorktreeSelect value={worktreeId} onChange={chooseWorktree} />
				</div>
				{error ? <p className="error">{error}</p> : null}
				{paths.length ? (
					<Tree paths={paths} onOpen={read} />
				) : (
					<p>Select worktree to load tree.</p>
				)}
			</div>
			<div
				className="card editor-pane"
				ref={editorRef}
				onScroll={(e) => persistScroll("files-editor-scroll", e.currentTarget)}
			>
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
									setPageState("files", { note: "" });
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
									setPageState("files", { note: "" });
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
					projectId={getSelection().selectedProjectId}
					worktreeId={worktreeId}
					onRefresh={loadAnnotations}
				/>
			</div>
			<div className="card files-project-chat">
				<textarea
					ref={projectChatRef}
					rows={1}
					value={projectMessage}
					onChange={(e) => {
						setProjectMessage(e.target.value);
						setPageState("files", { projectMessage: e.target.value });
					}}
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
						onChange={(id) => {
							setProjectChatAgentId(id);
							setPageState("files", { projectChatAgentId: id });
						}}
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
