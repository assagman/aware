import type { Annotation } from "@aware/shared";
import type {
	DiffLineAnnotation,
	FileDiffMetadata,
	OnDiffLineClickProps,
	SelectedLineRange,
} from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
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
	setSelectedWorktreeId,
} from "../app/selection";
import { AnnotationsPanel } from "../components/AnnotationsPanel";
import { WorktreeSelect } from "../components/WorktreeSelect";

type Ann = { text: string };
type LocalDiffAnnotation = DiffLineAnnotation<Ann> & {
	filePath?: string | undefined;
};
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
		return parsePatchFiles(patch, "aware-diff", false).flatMap(
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

const initialDiffState = getPageState("diffs", {
	mode: "unstaged" as DiffMode,
	commit: "",
	comment: "",
});

export function DiffsPage() {
	const diffScrollRef = useRef<HTMLDivElement | null>(null);
	const [worktreeId, setWorktreeId] = useState(getSelectedWorktreeId("diffs"));
	const [patch, setPatch] = useState("");
	const [selected, setSelected] = useState<SelectedLineRange | null>(null);
	const [selectedFile, setSelectedFile] = useState("");
	const [annotations, setAnnotations] = useState<LocalDiffAnnotation[]>([]);
	const [saved, setSaved] = useState<Annotation[]>([]);
	const [comment, setComment] = useState(initialDiffState.comment);
	const [mode, setMode] = useState<DiffMode>(initialDiffState.mode);
	const [commits, setCommits] = useState<GitCommit[]>([]);
	const [commit, setCommit] = useState(initialDiffState.commit);
	const files = useMemo(() => parseDiffFiles(patch), [patch]);
	const fallbackFiles = useMemo(() => diffFiles(patch), [patch]);
	const renderedAnnotations = useMemo(
		() => [...saved.map(toDiffAnnotation), ...annotations],
		[saved, annotations],
	);
	async function loadAnnotations(id = worktreeId) {
		if (id)
			setSaved(await apiGet<Annotation[]>(`/annotations?worktreeId=${id}`));
	}
	async function load(
		nextMode = mode,
		nextCommit = commit,
		nextId = worktreeId,
	) {
		const id = nextId;
		if (!id) return;
		const params = new URLSearchParams({ worktreeId: id, mode: nextMode });
		if (nextMode === "commit" && nextCommit) params.set("commit", nextCommit);
		setPatch(await fetch(`/api/diffs/git?${params}`).then((r) => r.text()));
		window.requestAnimationFrame(() =>
			restoreScroll("diffs-scroll", diffScrollRef.current),
		);
		setSelected(null);
		setSelectedFile("");
		await loadAnnotations(id);
	}
	async function loadCommits(nextId = worktreeId) {
		const id = nextId;
		if (!id) return;
		const nextCommits = await apiGet<GitCommit[]>(
			`/diffs/commits?worktreeId=${id}`,
		);
		setCommits(nextCommits);
		setCommit((current) => current || nextCommits[0]?.sha || "");
	}
	function selectMode(nextMode: DiffMode) {
		setMode(nextMode);
		setPageState("diffs", { mode: nextMode });
		void load(nextMode);
	}
	function selectCommit(nextCommit: string) {
		setCommit(nextCommit);
		setMode("commit");
		setPageState("diffs", { commit: nextCommit, mode: "commit" });
		void load("commit", nextCommit);
	}
	function selectLines(fileName: string, range: SelectedLineRange | null) {
		setSelected(range);
		setSelectedFile(range ? fileName : "");
	}
	function selectLine(fileName: string, line: OnDiffLineClickProps) {
		selectLines(fileName, {
			start: line.lineNumber,
			end: line.lineNumber,
			side: line.annotationSide,
			endSide: line.annotationSide,
		});
	}
	useEffect(() => {
		const reload = () => {
			const nextId = getSelectedWorktreeId("diffs");
			setWorktreeId(nextId);
			const saved = getPageState("diffs", initialDiffState);
			setMode(saved.mode);
			setCommit(saved.commit);
			setComment(saved.comment);
			void load(saved.mode, saved.commit, nextId);
			void loadCommits(nextId);
		};
		reload();
		window.addEventListener("aware-selection", reload);
		return () => window.removeEventListener("aware-selection", reload);
	}, []);

	function chooseWorktree(id: string) {
		setSelectedWorktreeId(id, "diffs");
		setWorktreeId(id);
		setPatch("");
		void load(mode, commit, id);
		void loadCommits(id);
	}

	async function addComment() {
		if (!selected || !comment.trim()) return;
		const side = selected.side === "deletions" ? "deletions" : "additions";
		const lineNumber = Math.max(selected.start, selected.end);
		setAnnotations((prev) => [
			...prev,
			{ filePath: selectedFile, side, lineNumber, metadata: { text: comment } },
		]);
		const { selectedProjectId, selectedTaskId } = getSelection();
		if (worktreeId)
			await apiPost("/annotations", {
				projectId: selectedProjectId || "local",
				worktreeId,
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
		setPageState("diffs", { comment: "" });
		await loadAnnotations();
	}
	return (
		<section id="diffs" className="three-pane diffs-layout full-workspace">
			<div className="card control-pane">
				<div className="panel-head">
					<h2>Diffs</h2>
					<WorktreeSelect value={worktreeId} onChange={chooseWorktree} />
				</div>
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
					<p>Click a diff line or line number to annotate.</p>
				)}
				<textarea
					value={comment}
					onChange={(e) => {
						setComment(e.target.value);
						setPageState("diffs", { comment: e.target.value });
					}}
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
			<div
				className="card diff-pane"
				ref={diffScrollRef}
				onScroll={(e) => persistScroll("diffs-scroll", e.currentTarget)}
			>
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
								onLineClick: (line) => selectLine(file.name, line),
								onLineNumberClick: (line) => selectLine(file.name, line),
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
			<AnnotationsPanel
				annotations={saved}
				projectId={getSelection().selectedProjectId}
				worktreeId={worktreeId}
				onRefresh={loadAnnotations}
			/>
		</section>
	);
}
