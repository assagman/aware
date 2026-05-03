import type { Annotation } from "@agent-ide/shared";
import type {
	DiffLineAnnotation,
	FileDiffMetadata,
	SelectedLineRange,
} from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../app/api";
import { getSelection } from "../app/selection";
import { AnnotationsPanel } from "../components/AnnotationsPanel";

type Ann = { text: string };
type LocalDiffAnnotation = DiffLineAnnotation<Ann> & { filePath?: string | undefined };
type DiffMode = "unstaged" | "staged" | "main" | "last" | "commit";
type GitCommit = {
	sha: string;
	subject: string;
	author: string;
	date: string;
};

function diffFiles(patch: string) {
	return [...patch.matchAll(/^diff --git a\/(.*?) b\//gm)].map((m) => m[1]);
}

function parseDiffFiles(patch: string) {
	try {
		return parsePatchFiles(patch, "agent-ide-diff", false).flatMap(
			(parsed) => parsed.files,
		);
	} catch {
		return [];
	}
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

function forFile(
	file: FileDiffMetadata,
	annotations: LocalDiffAnnotation[],
): DiffLineAnnotation<Ann>[] {
	return annotations
		.filter(
			(annotation) => !annotation.filePath || annotation.filePath === file.name,
		)
		.map(({ filePath: _filePath, ...annotation }) => annotation);
}

export function DiffsPage() {
	const [patch, setPatch] = useState("");
	const [selected, setSelected] = useState<SelectedLineRange | null>(null);
	const [selectedFile, setSelectedFile] = useState("");
	const [annotations, setAnnotations] = useState<LocalDiffAnnotation[]>([]);
	const [saved, setSaved] = useState<Annotation[]>([]);
	const [comment, setComment] = useState("");
	const [mode, setMode] = useState<DiffMode>("unstaged");
	const [commits, setCommits] = useState<GitCommit[]>([]);
	const [commit, setCommit] = useState("");
	const files = useMemo(() => parseDiffFiles(patch), [patch]);
	const fallbackFiles = useMemo(() => diffFiles(patch), [patch]);
	const renderedAnnotations = useMemo(
		() => [...saved.map(toDiffAnnotation), ...annotations],
		[saved, annotations],
	);
	async function loadAnnotations() {
		const id = getSelection().selectedWorktreeId;
		if (id)
			setSaved(await apiGet<Annotation[]>(`/annotations?worktreeId=${id}`));
	}
	async function load(nextMode = mode, nextCommit = commit) {
		const id = getSelection().selectedWorktreeId;
		if (!id) return;
		const params = new URLSearchParams({ worktreeId: id, mode: nextMode });
		if (nextMode === "commit" && nextCommit) params.set("commit", nextCommit);
		setPatch(await fetch(`/api/diffs/git?${params}`).then((r) => r.text()));
		setSelected(null);
		setSelectedFile("");
		await loadAnnotations();
	}
	async function loadCommits() {
		const id = getSelection().selectedWorktreeId;
		if (!id) return;
		const nextCommits = await apiGet<GitCommit[]>(
			`/diffs/commits?worktreeId=${id}`,
		);
		setCommits(nextCommits);
		setCommit((current) => current || nextCommits[0]?.sha || "");
	}
	function selectMode(nextMode: DiffMode) {
		setMode(nextMode);
		void load(nextMode);
	}
	function selectCommit(nextCommit: string) {
		setCommit(nextCommit);
		setMode("commit");
		void load("commit", nextCommit);
	}
	function selectLines(fileName: string, range: SelectedLineRange | null) {
		setSelected(range);
		setSelectedFile(range ? fileName : "");
	}
	useEffect(() => {
		const reload = () => {
			setMode("unstaged");
			void load("unstaged");
			void loadCommits();
		};
		reload();
		window.addEventListener("agent-ide-selection", reload);
		return () => window.removeEventListener("agent-ide-selection", reload);
	}, []);

	async function addComment() {
		if (!selected || !comment.trim()) return;
		const side = selected.side === "deletions" ? "deletions" : "additions";
		const lineNumber = Math.max(selected.start, selected.end);
		setAnnotations((prev) => [
			...prev,
			{ filePath: selectedFile, side, lineNumber, metadata: { text: comment } },
		]);
		const { selectedProjectId, selectedWorktreeId, selectedTaskId } =
			getSelection();
		if (selectedWorktreeId)
			await apiPost("/annotations", {
				projectId: selectedProjectId || "local",
				worktreeId: selectedWorktreeId,
				taskId: selectedTaskId || undefined,
				kind: "diff",
				filePath: selectedFile || undefined,
				side,
				startLine: selected.start,
				endLine: selected.end,
				text: comment.trim(),
				sent: false,
			});
		setSelected(null);
		setSelectedFile("");
		setComment("");
		await loadAnnotations();
	}
	return (
		<section id="diffs" className="three-pane diffs-layout full-workspace">
			<div className="card control-pane">
				<h2>Diffs</h2>
				<button type="button" onClick={() => selectMode("unstaged")}>
					unstaged
				</button>
				<button type="button" onClick={() => selectMode("staged")}>
					staged
				</button>
				<button type="button" onClick={() => selectMode("main")}>
					main..HEAD
				</button>
				<button type="button" onClick={() => selectMode("last")}>
					last commit
				</button>
				<label>
					commit
					<select
						value={commit}
						onChange={(event) => selectCommit(event.target.value)}
					>
						<option value="">pick commit</option>
						{commits.map((item) => (
							<option key={item.sha} value={item.sha}>
								{item.sha.slice(0, 8)} {item.date} {item.subject}
							</option>
						))}
					</select>
				</label>
				<p>
					Showing {mode === "commit" ? commit.slice(0, 8) || "commit" : mode}
				</p>
				{selected ? (
					<p>
						selected {selectedFile ? `${selectedFile}:` : ""}
						{selected.start}-{selected.end}
					</p>
				) : (
					<p>Select diff lines to annotate.</p>
				)}
				<textarea
					value={comment}
					onChange={(e) => setComment(e.target.value)}
					onKeyDown={(e) => {
						if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
							e.preventDefault();
							void addComment();
						}
					}}
					placeholder="comment on selected diff lines"
				/>
				<button type="button" onClick={addComment}>
					Annotate
				</button>
			</div>
			<div className="card diff-pane">
				{files.length ? (
					files.map((file) => (
						<FileDiff
							key={`${file.name}-${file.prevName ?? ""}`}
							fileDiff={file}
							disableWorkerPool
							selectedLines={selectedFile === file.name ? selected : null}
							lineAnnotations={forFile(file, renderedAnnotations)}
							renderAnnotation={(a) => (
								<div className="annotation">{a.metadata.text}</div>
							)}
							options={{
								enableLineSelection: true,
								onLineSelectionEnd: (range) => selectLines(file.name, range),
							}}
						/>
					))
				) : patch ? (
					<pre>
						{fallbackFiles.length
							? `Unable to render parsed diff for ${fallbackFiles.length} files.\n\n${patch}`
							: patch}
					</pre>
				) : (
					<pre>No diff loaded</pre>
				)}
			</div>
			<AnnotationsPanel annotations={saved} onRefresh={loadAnnotations} />
		</section>
	);
}
