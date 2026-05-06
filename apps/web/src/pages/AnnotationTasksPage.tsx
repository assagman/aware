import type { AgentRun, AnnotationTaskSuggestion, GraphProjection, Project } from "@aware/shared";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../app/api";
import { BusyIndicator } from "../components/BusyIndicator";

function labelStatus(status: string) {
	return status.replace(/_/g, " ");
}

type EditableSuggestion = {
	id?: string;
	title: string;
	body: string;
	annotationIds?: string[];
	status: AnnotationTaskSuggestion["status"];
};

export function AnnotationTasksPage() {
	const navigate = useNavigate();
	const { projectId = "" } = useParams();
	const [project, setProject] = useState<Project | null>(null);
	const [suggestions, setSuggestions] = useState<EditableSuggestion[]>([]);
	const [runs, setRuns] = useState<AgentRun[]>([]);
	const [loading, setLoading] = useState(true);
	const [generating, setGenerating] = useState(false);
	const [approving, setApproving] = useState(false);
	const [error, setError] = useState("");

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const [nextProject, nextSuggestions, graph] = await Promise.all([
				apiGet<Project>(`/projects/${encodeURIComponent(projectId)}`),
				apiGet<AnnotationTaskSuggestion[]>(`/projects/${encodeURIComponent(projectId)}/annotation-tasks`),
				apiGet<GraphProjection>(`/projects/${encodeURIComponent(projectId)}/graph`),
			]);
			setProject(nextProject);
			setSuggestions(nextSuggestions.map((item) => ({
				id: item.id,
				title: item.title,
				body: item.body,
				...(item.annotationIds?.length ? { annotationIds: item.annotationIds } : {}),
				status: item.status,
			})));
			setRuns(graph.runs.filter((run) => run.lane === "annotation-tasks").sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
			setError("");
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setLoading(false);
		}
	}, [projectId]);

	useEffect(() => { void load(); }, [load]);

	function updateSuggestion(index: number, patch: Partial<EditableSuggestion>) {
		setSuggestions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
	}

	function addDraft() {
		setSuggestions((current) => [{ title: "", body: "", status: "draft" }, ...current]);
	}

	function removeDraft(index: number) {
		setSuggestions((current) => current.filter((_, itemIndex) => itemIndex !== index));
	}

	async function generate() {
		if (generating) return;
		setGenerating(true);
		try {
			const run = await apiPost<AgentRun>(`/projects/${encodeURIComponent(projectId)}/annotation-tasks/generate`, {});
			navigate(`/projects/${encodeURIComponent(projectId)}/annotation-runs/${encodeURIComponent(run.id)}`);
		} finally {
			setGenerating(false);
		}
	}

	async function approve() {
		const payload = suggestions
			.map((suggestion) => ({
				...(suggestion.id ? { id: suggestion.id } : {}),
				title: suggestion.title.trim(),
				body: suggestion.body,
				...(suggestion.annotationIds?.length ? { annotationIds: suggestion.annotationIds } : {}),
			}))
			.filter((suggestion) => suggestion.title);
		if (approving || !payload.length) return;
		setApproving(true);
		try {
			const run = await apiPost<AgentRun>(`/projects/${encodeURIComponent(projectId)}/annotation-tasks/approve`, { suggestions: payload });
			navigate(`/projects/${encodeURIComponent(projectId)}/annotation-runs/${encodeURIComponent(run.id)}`);
		} finally {
			setApproving(false);
		}
	}

	if (loading && !project)
		return <section className="home-page route-state-page"><div className="home-empty"><BusyIndicator label="Loading AnnotationTasks" /></div></section>;
	if (error)
		return <section className="home-page route-state-page"><div className="home-empty"><h3>Invalid AnnotationTasks route</h3><p>{error}</p><Link to="/">Back to graph</Link></div></section>;

	const activeRun = runs.some((run) => run.status === "running" || run.status === "queued");
	const approvable = suggestions.some((suggestion) => suggestion.title.trim());

	return (
		<section className="home-run-fullscreen annotation-tasks-route-page">
			<header className="home-run-topbar">
				<button type="button" className="back-button" onClick={() => navigate(`/projects/${encodeURIComponent(projectId)}`)}>← Graph</button>
				<div className="home-run-title">
					<small>Annotation task generator</small>
					<h2>{project?.name ?? "AnnotationTasks"}</h2>
				</div>
				<div className="home-run-topbar-actions">
					<Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/annotations`}>Annotations</Link>
					<button type="button" disabled={generating || activeRun} onClick={() => void generate()}>{generating ? "Starting…" : activeRun ? "Graph Agent running" : "Generate suggestions"}</button>
					<button type="button" disabled={approving || !approvable} onClick={() => void approve()}>{approving ? "Starting…" : "Approve"}</button>
					<button type="button" onClick={addDraft}>Add draft</button>
					<button type="button" onClick={() => void load()}>Refresh</button>
				</div>
			</header>
			<div className="annotation-tasks-route-body">
				<section className="card annotation-task-editor-card">
					<div className="panel-head task-route-section-head">
						<div>
							<h2>Suggested tasks</h2>
							<small>Review, edit, then approve. Approval starts Graph Agent task creation.</small>
						</div>
						{loading ? <BusyIndicator label="Syncing" /> : null}
					</div>
					<div className="annotation-task-suggestion-list">
						{suggestions.map((suggestion, index) => (
							<article key={suggestion.id ?? `draft-${index}`} className="annotation-task-suggestion-card">
								<div className="annotation-item-head">
									<span className={`task-status status-${suggestion.status}`}>{labelStatus(suggestion.status)}</span>
									<button type="button" onClick={() => removeDraft(index)}>Remove</button>
								</div>
								<label>
									Title
									<input value={suggestion.title} onChange={(event) => updateSuggestion(index, { title: event.target.value })} />
								</label>
								<label>
									Body
									<textarea value={suggestion.body} onChange={(event) => updateSuggestion(index, { body: event.target.value })} />
								</label>
								<small>{suggestion.annotationIds?.length ? `annotations: ${suggestion.annotationIds.join(", ")}` : "no explicit source annotations"}</small>
							</article>
						))}
						{!suggestions.length ? <p className="empty-state">No suggestions yet. Generate with Graph Agent or add draft manually.</p> : null}
					</div>
				</section>
				<section className="card annotation-task-runs-card">
					<div className="panel-head task-route-section-head">
						<div>
							<h2>Generator runs</h2>
							<small>{runs.length} AnnotationTasks run{runs.length === 1 ? "" : "s"}</small>
						</div>
					</div>
					<div className="task-route-run-list">
						{runs.map((run) => (
							<Link key={run.id} to={`/projects/${encodeURIComponent(projectId)}/annotation-runs/${encodeURIComponent(run.id)}`} className="task-route-run-row annotation-task-run-row">
								<strong>{run.request || run.mainAgentName || run.id}</strong>
								<span className={`task-status status-${run.status}`}>{labelStatus(run.status)}</span>
							</Link>
						))}
						{!runs.length ? <p className="empty-state">No generator runs yet.</p> : null}
					</div>
				</section>
			</div>
		</section>
	);
}
