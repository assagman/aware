import type { Annotation } from "@agent-ide/shared";
import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../app/api";
import { getSelection } from "../app/selection";
import { AnnotationsPanel } from "../components/AnnotationsPanel";

type Ann = { text: string };

function diffFilePath(patch: string) {
	const matches = [...patch.matchAll(/^diff --git a\/(.*?) b\//gm)].map(
		(m) => m[1],
	);
	return matches.length === 1 ? matches[0] : undefined;
}

export function DiffsPage() {
	const [patch, setPatch] = useState("");
	const [selected, setSelected] = useState<SelectedLineRange | null>(null);
	const [annotations, setAnnotations] = useState<DiffLineAnnotation<Ann>[]>([]);
	const [saved, setSaved] = useState<Annotation[]>([]);
	const [comment, setComment] = useState("");
	async function loadAnnotations() {
		const id = getSelection().selectedWorktreeId;
		if (id)
			setSaved(await apiGet<Annotation[]>(`/annotations?worktreeId=${id}`));
	}
	async function load(mode = "unstaged") {
		const id = getSelection().selectedWorktreeId;
		if (!id) return;
		setPatch(
			await fetch(`/api/diffs/git?worktreeId=${id}&mode=${mode}`).then((r) =>
				r.text(),
			),
		);
		await loadAnnotations();
	}
	useEffect(() => {
		const reload = () => void load("unstaged");
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
			{ side, lineNumber, metadata: { text: comment } },
		]);
		const { selectedProjectId, selectedWorktreeId, selectedTaskId } =
			getSelection();
		const filePath = diffFilePath(patch);
		if (selectedWorktreeId)
			await apiPost("/annotations", {
				projectId: selectedProjectId || "local",
				worktreeId: selectedWorktreeId,
				taskId: selectedTaskId || undefined,
				kind: "diff",
				filePath,
				side,
				startLine: selected.start,
				endLine: selected.end,
				text: comment.trim(),
				sent: false,
			});
		setSelected(null);
		setComment("");
		await loadAnnotations();
	}
	return (
		<section id="diffs" className="three-pane diffs-layout full-workspace">
			<div className="card control-pane">
				<h2>Diffs</h2>
				<button type="button" onClick={() => load("unstaged")}>
					unstaged
				</button>
				<button type="button" onClick={() => load("staged")}>
					staged
				</button>
				{selected ? (
					<p>
						selected {selected.start}-{selected.end}
					</p>
				) : (
					<p>Select diff lines to annotate.</p>
				)}
				<textarea
					value={comment}
					onChange={(e) => setComment(e.target.value)}
					placeholder="comment on selected diff lines"
				/>
				<button type="button" onClick={addComment}>
					Annotate
				</button>
			</div>
			<div className="card diff-pane">
				{patch ? (
					<PatchDiff
						patch={patch}
						disableWorkerPool
						selectedLines={selected}
						lineAnnotations={annotations}
						renderAnnotation={(a) => (
							<div className="annotation">{a.metadata.text}</div>
						)}
						options={{
							enableLineSelection: true,
							onLineSelectionEnd: setSelected,
						}}
					/>
				) : (
					<pre>No diff loaded</pre>
				)}
			</div>
			<AnnotationsPanel annotations={saved} onRefresh={loadAnnotations} />
		</section>
	);
}
