import type { AgentRun, Annotation } from "@aware/shared";
import { apiPost } from "../app/api";
import { setSelectedRunId } from "../app/selection";
import { RunLink } from "./RunLink";

export function AnnotationsPanel({
	annotations,
	projectId,
	worktreeId,
	onRefresh,
}: {
	annotations: Annotation[];
	projectId: string;
	worktreeId: string;
	onRefresh: () => void;
}) {
	const sendableAnnotations = annotations.filter(
		(annotation) => annotation.status !== "processing",
	);
	async function sendAnnotation(annotation: Annotation) {
		if (!worktreeId) return;
		const run = await apiPost<AgentRun>("/chat", {
			projectId: projectId || annotation.projectId,
			worktreeId,
			annotationIds: [annotation.id],
			message: annotation.text,
		});
		setSelectedRunId(run.id);
		await onRefresh();
	}
	async function sendAllAnnotations() {
		if (!worktreeId || !sendableAnnotations.length) return;
		const run = await apiPost<AgentRun>("/chat", {
			projectId: projectId || sendableAnnotations[0]?.projectId,
			worktreeId,
			annotationIds: sendableAnnotations.map((annotation) => annotation.id),
			message: sendableAnnotations
				.map((annotation) => annotation.text)
				.join("\n\n"),
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
			{annotations.length ? (
				<div className="annotation-bulk-actions">
					<button
						type="button"
						disabled={!sendableAnnotations.length}
						onClick={() => void sendAllAnnotations()}
					>
						Send All
					</button>
				</div>
			) : (
				<p>None yet. Select lines/ranges.</p>
			)}
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
						<div className="annotation-actions">
							<button
								type="button"
								disabled={a.status === "processing"}
								onClick={() => void sendAnnotation(a)}
							>
								{a.status === "processing" ? "processing" : "send"}
							</button>
						</div>
					</li>
				))}
			</ul>
		</aside>
	);
}
