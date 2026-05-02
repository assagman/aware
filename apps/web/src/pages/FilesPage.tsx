import type { Annotation } from "@agent-ide/shared";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost } from "../app/api";
import { getSelection } from "../app/selection";
import { AnnotationsPanel } from "../components/AnnotationsPanel";

function Tree({
	paths,
	onOpen,
}: {
	paths: string[];
	onOpen: (path: string) => void;
}) {
	const { model } = useFileTree({
		paths,
		search: true,
		initialExpansion: "open",
	});
	useEffect(() => {
		const handler = () => {
			const selected = model.getSelectedPaths().find((p) => !p.endsWith("/"));
			if (selected) onOpen(selected);
		};
		const el = document.querySelector("#file-tree-host");
		el?.addEventListener("click", handler);
		return () => el?.removeEventListener("click", handler);
	}, [model, onOpen]);
	return (
		<FileTree
			id="file-tree-host"
			model={model}
			header="Files"
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
	const [annotations, setAnnotations] = useState<Annotation[]>([]);
	const loadedWorktreeId = useRef("");
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
				const savedFile = localStorage.getItem(`agent-ide-open-file:${id}`);
				if (savedFile) await read(savedFile);
				setError("");
			} catch (error) {
				setError(error instanceof Error ? error.message : String(error));
			}
		}
		void loadTree(true);
		const onSelection = () => void loadTree(false);
		window.addEventListener("agent-ide-selection", onSelection);
		return () => window.removeEventListener("agent-ide-selection", onSelection);
	}, []);
	async function read(path: string) {
		const id = getSelection().selectedWorktreeId;
		const text = await fetch(
			`/api/files/read?worktreeId=${id}&path=${encodeURIComponent(path)}`,
		).then((r) => r.text());
		if (id) localStorage.setItem(`agent-ide-open-file:${id}`, path);
		setFile(path);
		setContent(text);
		setAnchorLine(null);
		setEndLine(null);
		setNote("");
	}
	function selectLine(line: number, extend: boolean) {
		if (extend && anchorLine) setEndLine(line);
		else {
			setAnchorLine(line);
			setEndLine(line);
		}
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
		await apiPost("/annotations", body);
		setNote("");
		setAnchorLine(null);
		setEndLine(null);
		await loadAnnotations();
	}
	return (
		<section id="files" className="three-pane full-workspace">
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
				</div>
				{file ? (
					<div className="file-annotation-composer">
						<p>
							Select line. Shift-click another line for range. Write annotation,
							then save. Same flow as Diffs.
						</p>
						{selectedStart ? (
							<p>
								Selected lines {selectedStart}-{selectedEnd}
							</p>
						) : (
							<p>No line selected. Use "Annotate file" for file-level note.</p>
						)}
						<textarea
							value={note}
							onChange={(e) => setNote(e.target.value)}
							placeholder="comment on selected file lines"
						/>
						<button
							type="button"
							disabled={!note.trim() || !selectedStart}
							onClick={() =>
								saveAnnotation(selectedStart === selectedEnd ? "line" : "range")
							}
						>
							Annotate selected lines
						</button>
						<button
							type="button"
							disabled={!note.trim()}
							onClick={() => saveAnnotation("file")}
						>
							Annotate file
						</button>
						<button
							type="button"
							onClick={() => {
								setAnchorLine(null);
								setEndLine(null);
							}}
						>
							clear selection
						</button>
					</div>
				) : null}
				{wholeFileAnnotations.map((a) => (
					<div
						key={a.id}
						className={`inline-annotation ${a.status === "processing" ? "processing" : ""}`}
					>
						<strong>File note:</strong> {a.text}
						{a.runId ? <a href="#runs"> run {a.runId.slice(0, 8)}</a> : null}
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
											<a href="#runs"> run {a.runId.slice(0, 8)}</a>
										) : null}
									</div>
								))}
							</div>
						);
					})}
				</div>
			</div>
			<div>
				<AnnotationsPanel
					annotations={file ? fileAnnotations : annotations}
					onRefresh={loadAnnotations}
				/>
			</div>
		</section>
	);
}
