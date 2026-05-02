import type { Annotation } from "@agent-ide/shared";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../app/api";
import { getSelection } from "../app/selection";
import { AnnotationsPanel } from "../components/AnnotationsPanel";
import { DirectChat } from "../components/DirectChat";

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
			style={{ height: 420 }}
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
	const lines = useMemo(() => content.split("\n"), [content]);
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
		async function loadTree() {
			const id = getSelection().selectedWorktreeId;
			if (!id) {
				setPaths([]);
				setError("Select project + worktree at top first.");
				return;
			}
			try {
				setPaths(await apiGet<string[]>(`/files/tree?worktreeId=${id}`));
				await loadAnnotations();
				setError("");
			} catch (error) {
				setError(error instanceof Error ? error.message : String(error));
			}
		}
		void loadTree();
		window.addEventListener("agent-ide-selection", loadTree);
		return () => window.removeEventListener("agent-ide-selection", loadTree);
	}, []);
	async function read(path: string) {
		const id = getSelection().selectedWorktreeId;
		const text = await fetch(
			`/api/files/read?worktreeId=${id}&path=${encodeURIComponent(path)}`,
		).then((r) => r.text());
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
		};
		await apiPost("/annotations", body);
		setNote("");
		await loadAnnotations();
	}
	return (
		<section id="files" className="three-pane">
			<div className="card">
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
					<button
						type="button"
						disabled={!file || !note.trim()}
						onClick={() => saveAnnotation("file")}
					>
						Annotate file
					</button>
				</div>
				{file ? (
					<p>
						Select line. Shift-click another line for range. Add note, then
						Annotate.
					</p>
				) : null}
				{anchorLine ? (
					<div className="inline-popover">
						Lines {selectedStart}-{selectedEnd}
						<input
							value={note}
							onChange={(e) => setNote(e.target.value)}
							placeholder="annotation note"
						/>
						<button
							type="button"
							disabled={!note.trim()}
							onClick={() =>
								saveAnnotation(selectedStart === selectedEnd ? "line" : "range")
							}
						>
							Annotate
						</button>
						<button
							type="button"
							onClick={() => {
								setAnchorLine(null);
								setEndLine(null);
							}}
						>
							clear
						</button>
					</div>
				) : null}
				<div className="code-lines">
					{lines.map((line, i) => {
						const n = i + 1;
						const selected =
							selectedStart &&
							selectedEnd &&
							n >= selectedStart &&
							n <= selectedEnd;
						return (
							<button
								key={`${file}-${n}`}
								type="button"
								className={`code-line ${selected ? "selected" : ""}`}
								onClick={(e) => selectLine(n, e.shiftKey)}
							>
								<span className="line-no">{n}</span>
								<code>{line || " "}</code>
							</button>
						);
					})}
				</div>
			</div>
			<div>
				<AnnotationsPanel
					annotations={annotations}
					onRefresh={loadAnnotations}
				/>
				<DirectChat onSent={loadAnnotations} />
			</div>
		</section>
	);
}
