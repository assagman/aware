import type { Annotation } from "@agent-ide/shared";
import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../app/api";
import { getSelection } from "../app/selection";
import { AnnotationsPanel } from "../components/AnnotationsPanel";

type Ann = { text: string };
type DiffMode = "unstaged" | "staged" | "main" | "last" | "commit";
type GitCommit = {
	sha: string;
	subject: string;
	author: string;
	date: string;
};

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
	const [mode, setMode] = useState<DiffMode>("unstaged");
	const [commits, setCommits] = useState<GitCommit[]>([]);
	const [commit, setCommit] = useState("");
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
