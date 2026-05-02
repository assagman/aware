import type { Annotation } from "@agent-ide/shared";
import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import { useState } from "react";
import { apiGet, apiPost } from "../app/api";
import { getSelection } from "../app/selection";
import { AnnotationsPanel } from "../components/AnnotationsPanel";
import { DirectChat } from "../components/DirectChat";

type Ann = { text: string };

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
	async function addComment() {
		if (!selected || !comment) return;
		const side = selected.side === "deletions" ? "deletions" : "additions";
		const lineNumber = Math.max(selected.start, selected.end);
		setAnnotations((prev) => [
			...prev,
			{ side, lineNumber, metadata: { text: comment } },
		]);
		const { selectedProjectId, selectedWorktreeId, selectedTaskId } =
			getSelection();
		if (selectedWorktreeId)
			await apiPost("/annotations", {
				projectId: selectedProjectId || "local",
				worktreeId: selectedWorktreeId,
				taskId: selectedTaskId || undefined,
				kind: "diff",
				side,
				startLine: selected.start,
				endLine: selected.end,
				text: comment,
				sent: false,
			});
		setComment("");
		await loadAnnotations();
	}
	return (
		<section id="diffs" className="three-pane diffs-layout">
			<div className="card">
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
				<input
					value={comment}
					onChange={(e) => setComment(e.target.value)}
					placeholder="comment on selected lines"
				/>
				<button type="button" onClick={addComment}>
					Annotate
				</button>
				<DirectChat onSent={loadAnnotations} />
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
