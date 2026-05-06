import type { AgentRun, Annotation, GraphProjection, Project, Worktree } from "@aware/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiGet, apiPost } from "../app/api";
import { BusyIndicator } from "../components/BusyIndicator";

function labelStatus(status: string) {
	return status.replace(/_/g, " ");
}

function annotationLocation(annotation: Annotation) {
	const path = annotation.filePath || "(missing file)";
	if (!annotation.startLine) return path;
	return annotation.endLine && annotation.endLine !== annotation.startLine
		? `${path}:${annotation.startLine}-${annotation.endLine}`
		: `${path}:${annotation.startLine}`;
}

function worktreeName(worktree: Worktree | undefined) {
	if (!worktree) return "all worktrees";
	return worktree.branch || worktree.path.split("/").filter(Boolean).at(-1) || worktree.path;
}

export function AnnotationsPage() {
	const navigate = useNavigate();
	const { projectId = "" } = useParams();
	const [searchParams, setSearchParams] = useSearchParams();
	const worktreeId = searchParams.get("worktreeId") ?? "";
	const [project, setProject] = useState<Project | null>(null);
	const [annotations, setAnnotations] = useState<Annotation[]>([]);
	const [runs, setRuns] = useState<AgentRun[]>([]);
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [loading, setLoading] = useState(true);
	const [running, setRunning] = useState("");
	const [error, setError] = useState("");

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const query = worktreeId ? `?${new URLSearchParams({ worktreeId })}` : "";
			const [nextProject, nextAnnotations, graph] = await Promise.all([
				apiGet<Project>(`/projects/${encodeURIComponent(projectId)}`),
				apiGet<Annotation[]>(`/projects/${encodeURIComponent(projectId)}/annotations${query}`),
				apiGet<GraphProjection>(`/projects/${encodeURIComponent(projectId)}/graph`),
			]);
			setProject(nextProject);
			setAnnotations(nextAnnotations.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
			setRuns(graph.runs.filter((run) => run.lane === "annotation").sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
			setWorktrees(graph.worktrees);
			setError("");
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setLoading(false);
		}
	}, [projectId, worktreeId]);

	useEffect(() => { void load(); }, [load]);

	const selectedWorktree = useMemo(() => worktrees.find((worktree) => worktree.id === worktreeId), [worktreeId, worktrees]);
	const runsByAnnotation = useMemo(() => {
		const groups = new Map<string, AgentRun[]>();
		for (const run of runs) {
			for (const annotationId of run.annotationIds ?? []) {
				const group = groups.get(annotationId) ?? [];
				group.push(run);
				groups.set(annotationId, group);
			}
		}
		return groups;
	}, [runs]);

	async function runAnnotation(annotation: Annotation) {
		if (running) return;
		setRunning(annotation.id);
		try {
			const run = await apiPost<AgentRun>(`/projects/${encodeURIComponent(projectId)}/annotations/${encodeURIComponent(annotation.id)}/runs`, {});
			navigate(`/projects/${encodeURIComponent(projectId)}/annotation-runs/${encodeURIComponent(run.id)}`);
		} finally {
			setRunning("");
		}
	}

	async function runAll(mode: "combined" | "separate") {
		if (running || !annotations.length) return;
		setRunning(mode);
		try {
			const result = await apiPost<AgentRun | AgentRun[]>(`/projects/${encodeURIComponent(projectId)}/annotations/runs`, {
				mode,
				annotationIds: annotations.map((annotation) => annotation.id),
			});
			const first = Array.isArray(result) ? result[0] : result;
			if (first) navigate(`/projects/${encodeURIComponent(projectId)}/annotation-runs/${encodeURIComponent(first.id)}`);
		} finally {
			setRunning("");
		}
	}

	if (loading && !project)
		return <section className="home-page route-state-page"><div className="home-empty"><BusyIndicator label="Loading annotations" /></div></section>;
	if (error)
		return <section className="home-page route-state-page"><div className="home-empty"><h3>Invalid annotations route</h3><p>{error}</p><Link to="/">Back to graph</Link></div></section>;

	return (
		<section className="home-run-fullscreen annotations-route-page">
			<header className="home-run-topbar">
				<button type="button" className="back-button" onClick={() => navigate(`/projects/${encodeURIComponent(projectId)}`)}>← Graph</button>
				<div className="home-run-title">
					<small>Annotations · {worktreeName(selectedWorktree)}</small>
					<h2>{project?.name ?? "Annotations"}</h2>
				</div>
				<div className="home-run-topbar-actions">
					<Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/annotation-tasks`}>AnnotationTasks</Link>
					{worktreeId ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/files`}>Files</Link> : null}
					{worktreeId ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/diffs`}>Diffs</Link> : null}
					<button type="button" disabled={!worktreeId} onClick={() => setSearchParams({}, { replace: true })}>All worktrees</button>
					<button type="button" disabled={Boolean(running) || !annotations.length} onClick={() => void runAll("combined")}>{running === "combined" ? "Starting…" : "Auto Create Runs"}</button>
					<button type="button" disabled={Boolean(running) || !annotations.length} onClick={() => void runAll("separate")}>Run separately</button>
					<button type="button" onClick={() => void load()}>Refresh</button>
				</div>
			</header>
			<div className="annotations-route-body">
				<section className="card annotations-list-card">
					<div className="panel-head task-route-section-head">
						<div>
							<h2>Annotation lane</h2>
							<small>{annotations.length} annotation{annotations.length === 1 ? "" : "s"}</small>
						</div>
						{loading ? <BusyIndicator label="Syncing" /> : null}
					</div>
					<div className="annotation-item-list">
						{annotations.map((annotation) => {
							const annotationRuns = runsByAnnotation.get(annotation.id) ?? [];
							return (
								<article key={annotation.id} className="annotation-item-card">
									<div className="annotation-item-head">
										<div>
											<small>{annotation.kind}{annotation.side ? ` · ${annotation.side}` : ""}</small>
											<h3>{annotationLocation(annotation)}</h3>
										</div>
										<div className="annotation-item-actions">
											<span className={`task-status status-${annotation.status ?? "pending"}`}>{labelStatus(annotation.status ?? "pending")}</span>
											<button type="button" disabled={Boolean(running)} onClick={() => void runAnnotation(annotation)}>{running === annotation.id ? "Starting…" : "Run"}</button>
										</div>
									</div>
									{annotation.text ? <p className="annotation-note">{annotation.text}</p> : null}
									{annotation.selectedText ? <pre className="annotation-context">{annotation.selectedText}</pre> : null}
									<div className="annotation-runs-list">
										<strong>Runs</strong>
										{annotationRuns.map((run) => (
											<Link key={run.id} to={`/projects/${encodeURIComponent(projectId)}/annotation-runs/${encodeURIComponent(run.id)}`} className="task-route-run-row annotation-run-row">
												<span>{run.request || run.mainAgentName || run.id}</span>
												<span className={`task-status status-${run.status}`}>{labelStatus(run.status)}</span>
											</Link>
										))}
										{!annotationRuns.length ? <p className="empty-state">No runs yet.</p> : null}
									</div>
								</article>
							);
						})}
						{!annotations.length ? <p className="empty-state">No annotations yet. Select text in Files/Diffs, then Annotate.</p> : null}
					</div>
				</section>
			</div>
		</section>
	);
}
