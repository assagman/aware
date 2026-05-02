import type { AgentRun, Annotation } from "@agent-ide/shared";
import { apiPost } from "../app/api";
import { getSelection, setSelectedRunId } from "../app/selection";
import { RunLink } from "./RunLink";

export function AnnotationsPanel({
	annotations,
	onRefresh,
}: {
	annotations: Annotation[];
	onRefresh: () => void;
}) {
	async function sendAnnotation(annotation: Annotation) {
		const { selectedProjectId, selectedWorktreeId } = getSelection();
		if (!selectedWorktreeId) return;
		const run = await apiPost<AgentRun>("/chat", {
			projectId: selectedProjectId || annotation.projectId,
			worktreeId: selectedWorktreeId,
			annotationIds: [annotation.id],
			message: annotation.text,
		});
		setSelectedRunId(run.id);
		await onRefresh();
	}
	return (
		<aside className="annotations-panel">
			<div className="panel-head">
				<h3>Annotations</h3>
				<button type="button" onClick={onRefresh}>
					refresh
				</button>
			</div>
			{annotations.length === 0 ? <p>None yet. Select lines/ranges.</p> : null}
			<ul>
				{annotations.map((a) => (
					<li
						key={a.id}
						className={a.status === "processing" ? "processing" : ""}
					>
						<strong>{a.kind}</strong> {a.filePath || "(missing file)"}
						{a.startLine
							? `:${a.startLine}${a.endLine ? `-${a.endLine}` : ""}`
							: ""}
						<p>{a.text}</p>
						{a.runId ? <RunLink runId={a.runId} /> : null}
						<button
							type="button"
							disabled={a.status === "processing"}
							onClick={() => void sendAnnotation(a)}
						>
							{a.status === "processing" ? "processing" : "send"}
						</button>
					</li>
				))}
			</ul>
		</aside>
	);
}
