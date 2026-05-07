import type { AgentRun, Annotation, AnnotationTaskSuggestion, GraphProjection, Project, Worktree } from "@aware/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiGet, apiPost } from "../app/api";
import { BusyIndicator } from "../components/BusyIndicator";

type AnnotationMode = "active" | "archive" | "history";
type AnnotationHistory = {
	annotations: Annotation[];
	runs: AgentRun[];
	suggestions: AnnotationTaskSuggestion[];
};
type EditableSuggestion = {
	id: string;
	title: string;
	body: string;
	status: AnnotationTaskSuggestion["status"];
	targetKind: "task" | "run";
	annotationIds?: string[];
	worktreeId?: string;
	taskId?: string;
	runId?: string;
};
type ApprovalResult = { run?: AgentRun; task?: { id: string } };

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

function runHref(projectId: string, run: AgentRun) {
	return `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(run.taskId)}/runs/${encodeURIComponent(run.id)}`;
}

function modeFromPath(pathname: string): AnnotationMode {
	if (pathname.endsWith("/archive")) return "archive";
	if (pathname.endsWith("/history")) return "history";
	return "active";
}

function toEditable(suggestion: AnnotationTaskSuggestion): EditableSuggestion {
	return {
		id: suggestion.id,
		title: suggestion.title,
		body: suggestion.body,
		status: suggestion.status,
		targetKind: suggestion.targetKind ?? "task",
		...(suggestion.annotationIds?.length ? { annotationIds: suggestion.annotationIds } : {}),
		...(suggestion.worktreeId ? { worktreeId: suggestion.worktreeId } : {}),
		...(suggestion.taskId ? { taskId: suggestion.taskId } : {}),
		...(suggestion.runId ? { runId: suggestion.runId } : {}),
	};
}

export function AnnotationsPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const mode = modeFromPath(location.pathname);
	const { projectId = "" } = useParams();
	const [searchParams, setSearchParams] = useSearchParams();
	const worktreeId = searchParams.get("worktreeId") ?? "";
	const [project, setProject] = useState<Project | null>(null);
	const [annotations, setAnnotations] = useState<Annotation[]>([]);
	const [runs, setRuns] = useState<AgentRun[]>([]);
	const [suggestions, setSuggestions] = useState<EditableSuggestion[]>([]);
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [prompt, setPrompt] = useState("");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const state = mode === "archive" ? "archived" : mode === "history" ? "all" : "active";
			const params = new URLSearchParams({ state });
			if (worktreeId) params.set("worktreeId", worktreeId);
			const [nextProject, nextAnnotations, graph, nextSuggestions, history] = await Promise.all([
				apiGet<Project>(`/projects/${encodeURIComponent(projectId)}`),
				apiGet<Annotation[]>(`/projects/${encodeURIComponent(projectId)}/annotations?${params}`),
				apiGet<GraphProjection>(`/projects/${encodeURIComponent(projectId)}/graph`),
				apiGet<AnnotationTaskSuggestion[]>(`/projects/${encodeURIComponent(projectId)}/annotations/suggestions`),
				apiGet<AnnotationHistory>(`/projects/${encodeURIComponent(projectId)}/annotations/history`),
			]);
			setProject(nextProject);
			setAnnotations((mode === "history" ? history.annotations : nextAnnotations).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
			setRuns(history.runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
			setSuggestions((mode === "history" ? history.suggestions : nextSuggestions).map(toEditable));
			setWorktrees(graph.worktrees);
			setSelectedIds((current) => current.filter((id) => nextAnnotations.some((annotation) => annotation.id === id)));
			setError("");
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setLoading(false);
		}
	}, [mode, projectId, worktreeId]);

	useEffect(() => { void load(); }, [load]);

	const selectedWorktree = useMemo(() => worktrees.find((worktree) => worktree.id === worktreeId), [worktreeId, worktrees]);
	const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
	const activeAnnotations = annotations.filter((annotation) => !annotation.archivedAt && annotation.status !== "archived");
	const runEligibleAnnotations = mode === "active" ? activeAnnotations : [];
	const selectedAnnotations = runEligibleAnnotations.filter((annotation) => selectedSet.has(annotation.id));
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
	const activeGenerator = runs.some((run) => run.lane === "annotation-tasks" && (run.status === "running" || run.status === "queued"));

	function setSelected(annotationId: string, selected: boolean) {
		setSelectedIds((current) => selected ? [...new Set([...current, annotationId])] : current.filter((id) => id !== annotationId));
	}

	function selectAll() {
		setSelectedIds(runEligibleAnnotations.map((annotation) => annotation.id));
	}

	function updateSuggestion(index: number, patch: Partial<EditableSuggestion>) {
		setSuggestions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
	}

	async function runAnnotations(ids: string[], marker: string) {
		if (busy || !ids.length) return;
		setBusy(marker);
		try {
			const run = await apiPost<AgentRun>(`/projects/${encodeURIComponent(projectId)}/annotations/runs`, {
				annotationIds: ids,
				message: prompt.trim(),
			});
			setPrompt("");
			navigate(runHref(projectId, run));
		} finally {
			setBusy("");
		}
	}

	async function runAnnotation(annotation: Annotation) {
		if (busy) return;
		setBusy(annotation.id);
		try {
			const run = await apiPost<AgentRun>(`/projects/${encodeURIComponent(projectId)}/annotations/${encodeURIComponent(annotation.id)}/runs`, { message: prompt.trim() });
			setPrompt("");
			navigate(runHref(projectId, run));
		} finally {
			setBusy("");
		}
	}

	async function archiveSelected() {
		if (busy || !selectedIds.length) return;
		setBusy("archive");
		try {
			await Promise.all(selectedIds.map((id) => apiPost(`/projects/${encodeURIComponent(projectId)}/annotations/${encodeURIComponent(id)}/archive`, {})));
			setSelectedIds([]);
			await load();
		} finally {
			setBusy("");
		}
	}

	async function restoreSelected() {
		if (busy || !selectedIds.length) return;
		setBusy("restore");
		try {
			await Promise.all(selectedIds.map((id) => apiPost(`/projects/${encodeURIComponent(projectId)}/annotations/${encodeURIComponent(id)}/restore`, {})));
			setSelectedIds([]);
			await load();
		} finally {
			setBusy("");
		}
	}

	async function generateSuggestions() {
		if (busy || activeGenerator) return;
		setBusy("generate");
		try {
			const run = await apiPost<AgentRun>(`/projects/${encodeURIComponent(projectId)}/annotations/suggestions`, {
				...(selectedIds.length ? { annotationIds: selectedIds } : {}),
				...(worktreeId ? { worktreeId } : {}),
			});
			navigate(runHref(projectId, run));
		} finally {
			setBusy("");
		}
	}

	async function approveSuggestion(index: number) {
		const suggestion = suggestions[index];
		if (!suggestion || busy) return;
		setBusy(`approve:${suggestion.id}`);
		try {
			const result = await apiPost<ApprovalResult>(`/projects/${encodeURIComponent(projectId)}/annotations/suggestions/${encodeURIComponent(suggestion.id)}/approve`, {
				title: suggestion.title,
				body: suggestion.body,
				targetKind: suggestion.targetKind,
				...(suggestion.annotationIds?.length ? { annotationIds: suggestion.annotationIds } : {}),
				...(suggestion.worktreeId ? { worktreeId: suggestion.worktreeId } : {}),
				...(suggestion.taskId ? { taskId: suggestion.taskId } : {}),
			});
			if (result.run) navigate(runHref(projectId, result.run));
			else await load();
		} finally {
			setBusy("");
		}
	}

	async function rejectSuggestion(suggestion: EditableSuggestion) {
		if (busy) return;
		setBusy(`reject:${suggestion.id}`);
		try {
			await apiPost(`/projects/${encodeURIComponent(projectId)}/annotations/suggestions/${encodeURIComponent(suggestion.id)}/reject`, {});
			await load();
		} finally {
			setBusy("");
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
					<small>Annotations · {mode} · {worktreeName(selectedWorktree)}</small>
					<h2>{project?.name ?? "Annotations"}</h2>
				</div>
				<div className="home-run-topbar-actions">
					<Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/annotations`}>Active</Link>
					<Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/annotations/archive`}>Archive</Link>
					<Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/annotations/history`}>History</Link>
					{worktreeId ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/files`}>Files</Link> : null}
					{worktreeId ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/diffs`}>Diffs</Link> : null}
					<button type="button" disabled={!worktreeId} onClick={() => setSearchParams({}, { replace: true })}>All worktrees</button>
					<button type="button" onClick={() => void load()}>Refresh</button>
				</div>
			</header>
			<div className="annotations-route-body">
				<section className="card annotations-list-card">
					<div className="panel-head task-route-section-head">
						<div>
							<h2>{mode === "archive" ? "Archived annotations" : mode === "history" ? "Annotation history" : "Active annotations"}</h2>
							<small>{annotations.length} annotation{annotations.length === 1 ? "" : "s"} · {selectedIds.length} selected</small>
						</div>
						{loading ? <BusyIndicator label="Syncing" /> : null}
					</div>
					{mode === "active" ? (
						<div className="annotation-command-panel">
							<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Optional extra prompt before submitting annotations…" />
							<div className="annotation-bulk-actions">
								<button type="button" disabled={!runEligibleAnnotations.length} onClick={selectAll}>Select all</button>
								<button type="button" disabled={!selectedIds.length} onClick={() => setSelectedIds([])}>Clear</button>
								<button type="button" disabled={Boolean(busy) || !selectedAnnotations.length} onClick={() => void runAnnotations(selectedAnnotations.map((annotation) => annotation.id), "selected")}>{busy === "selected" ? "Starting…" : "Run selected"}</button>
								<button type="button" disabled={Boolean(busy) || !runEligibleAnnotations.length} onClick={() => void runAnnotations(runEligibleAnnotations.map((annotation) => annotation.id), "all")}>{busy === "all" ? "Starting…" : "Run all"}</button>
								<button type="button" disabled={Boolean(busy) || !selectedIds.length} onClick={() => void archiveSelected()}>{busy === "archive" ? "Archiving…" : "Archive selected"}</button>
								<button type="button" disabled={Boolean(busy) || activeGenerator} onClick={() => void generateSuggestions()}>{busy === "generate" ? "Starting…" : activeGenerator ? "Generator running" : "Generate suggestions"}</button>
							</div>
						</div>
					) : mode === "archive" ? (
						<div className="annotation-bulk-actions">
							<button type="button" disabled={!annotations.length} onClick={selectAll}>Select all</button>
							<button type="button" disabled={!selectedIds.length} onClick={() => setSelectedIds([])}>Clear</button>
							<button type="button" disabled={Boolean(busy) || !selectedIds.length} onClick={() => void restoreSelected()}>{busy === "restore" ? "Restoring…" : "Restore selected"}</button>
						</div>
					) : null}
					<div className="annotation-item-list">
						{annotations.map((annotation) => {
							const annotationRuns = runsByAnnotation.get(annotation.id) ?? [];
							const checked = selectedSet.has(annotation.id);
							return (
								<article key={annotation.id} className="annotation-item-card">
									<div className="annotation-item-head">
										<label className="annotation-select-label">
											<input type="checkbox" checked={checked} onChange={(event) => setSelected(annotation.id, event.target.checked)} />
											<span>
												<small>{annotation.kind}{annotation.side ? ` · ${annotation.side}` : ""} · {worktreeName(worktrees.find((worktree) => worktree.id === annotation.worktreeId))}</small>
												<h3>{annotationLocation(annotation)}</h3>
											</span>
										</label>
										<div className="annotation-item-actions">
											<span className={`task-status status-${annotation.status ?? "pending"}`}>{labelStatus(annotation.status ?? "pending")}</span>
											{mode === "active" ? <button type="button" disabled={Boolean(busy)} onClick={() => void runAnnotation(annotation)}>{busy === annotation.id ? "Starting…" : "Run"}</button> : null}
										</div>
									</div>
									{annotation.text ? <p className="annotation-note">{annotation.text}</p> : null}
									{annotation.selectedText ? <pre className="annotation-context">{annotation.selectedText}</pre> : null}
									<div className="annotation-runs-list">
										<strong>Runs</strong>
										{annotationRuns.map((run) => (
											<Link key={run.id} to={runHref(projectId, run)} className="task-route-run-row annotation-run-row">
												<span>{run.request || run.mainAgentName || run.id}</span>
												<span className={`task-status status-${run.status}`}>{labelStatus(run.status)}</span>
											</Link>
										))}
										{!annotationRuns.length ? <p className="empty-state">No runs yet.</p> : null}
									</div>
								</article>
							);
						})}
						{!annotations.length ? <p className="empty-state">No annotations here. Select text in Files/Diffs, then Annotate.</p> : null}
					</div>
				</section>
				<section className="card annotation-task-editor-card">
					<div className="panel-head task-route-section-head">
						<div>
							<h2>Suggestions</h2>
							<small>Default worktree → tasks. Custom worktree → runs.</small>
						</div>
					</div>
					<div className="annotation-task-suggestion-list">
						{suggestions.map((suggestion, index) => (
							<article key={suggestion.id} className="annotation-task-suggestion-card">
								<div className="annotation-item-head">
									<span className={`task-status status-${suggestion.status}`}>{labelStatus(suggestion.status)}</span>
									<select value={suggestion.targetKind} onChange={(event) => updateSuggestion(index, { targetKind: event.target.value as "task" | "run" })}>
										<option value="task">task</option>
										<option value="run">run</option>
									</select>
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
								<div className="annotation-bulk-actions">
									{suggestion.runId && suggestion.taskId ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(suggestion.taskId)}/runs/${encodeURIComponent(suggestion.runId)}`}>Run</Link> : null}
									<button type="button" disabled={Boolean(busy) || suggestion.status === "created" || suggestion.status === "rejected"} onClick={() => void approveSuggestion(index)}>{busy === `approve:${suggestion.id}` ? "Approving…" : "Approve"}</button>
									<button type="button" disabled={Boolean(busy) || suggestion.status === "rejected"} onClick={() => void rejectSuggestion(suggestion)}>{busy === `reject:${suggestion.id}` ? "Rejecting…" : "Reject"}</button>
								</div>
							</article>
						))}
						{!suggestions.length ? <p className="empty-state">No suggestions yet.</p> : null}
					</div>
				</section>
				{mode === "history" ? (
					<section className="card annotation-task-runs-card">
						<div className="panel-head task-route-section-head"><div><h2>Annotation runs</h2><small>{runs.length} run{runs.length === 1 ? "" : "s"}</small></div></div>
						<div className="task-route-run-list">
							{runs.map((run) => (
								<Link key={run.id} to={runHref(projectId, run)} className="task-route-run-row annotation-task-run-row">
									<strong>{run.request || run.mainAgentName || run.id}</strong>
									<span className={`task-status status-${run.status}`}>{labelStatus(run.status)}</span>
								</Link>
							))}
							{!runs.length ? <p className="empty-state">No annotation runs yet.</p> : null}
						</div>
					</section>
				) : null}
			</div>
		</section>
	);
}
