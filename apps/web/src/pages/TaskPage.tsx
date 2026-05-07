import type { AgentRun, GraphProjection, RunLane, Task, Worktree } from "@aware/shared";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiGet, apiPatch, apiPost } from "../app/api";
import { runAfterMarkDoneSuccess } from "../app/markDoneGraphFocus";
import { BusyIndicator } from "../components/BusyIndicator";
import { MarkdownText } from "./HomePage";

function labelStatus(status: string) {
	return status.replace(/_/g, " ");
}

function activeRuns(runs: AgentRun[]) {
	return runs.filter((run) => !run.deletedAt);
}

function worktreeName(worktree: Worktree | undefined) {
	if (!worktree) return "?";
	return worktree.path.split("/").filter(Boolean).at(-1) || worktree.path;
}

type UserRunLane = Extract<RunLane, "task" | "gate">;

function runLane(run: AgentRun): RunLane {
	return run.lane === "gate" || run.lane === "ship" || run.lane === "graph" ? run.lane : "task";
}

export function TaskPage() {
	const navigate = useNavigate();
	const { projectId = "", taskId = "" } = useParams();
	const [task, setTask] = useState<Task | null>(null);
	const [runs, setRuns] = useState<AgentRun[]>([]);
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [message, setMessage] = useState("");
	const [gateMessage, setGateMessage] = useState("");
	const [editing, setEditing] = useState(false);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [starting, setStarting] = useState(false);
	const [checkpointing, setCheckpointing] = useState(false);
	const [graphing, setGraphing] = useState(false);
	const [error, setError] = useState("");
	const [graphError, setGraphError] = useState("");

	async function load() {
		setLoading(true);
		try {
			const nextTask = await apiGet<Task>(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`);
			const graph = await apiGet<GraphProjection>(`/projects/${encodeURIComponent(projectId)}/graph${nextTask.archivedAt ? "?history=1" : ""}`);
			setTask(nextTask);
			setTitle(nextTask.title);
			setBody(nextTask.body);
			setEditing(false);
			setRuns(graph.runs.filter((run) => run.taskId === nextTask.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
			setWorktrees(graph.worktrees);
			setError("");
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => { void load(); }, [projectId, taskId]);

	const worktree = useMemo(
		() => task?.worktreeId ? worktrees.find((item) => item.id === task.worktreeId) : undefined,
		[task?.worktreeId, worktrees],
	);
	const taskLaneRuns = runs.filter((run) => runLane(run) === "task");
	const gateRuns = runs.filter((run) => runLane(run) === "gate");
	const graphRuns = runs.filter((run) => runLane(run) === "graph");
	const activeGraphRun = graphRuns.some((run) => run.status === "running" || run.status === "queued");
	const isArchived = Boolean(task?.archivedAt);
	const active = activeRuns(taskLaneRuns);
	const canCheckpoint = !isArchived && active.length > 0 && active.every((run) => run.status === "done");

	async function save() {
		if (!task || isArchived || saving || !title.trim()) return;
		setSaving(true);
		try {
			const updated = await apiPatch<Task>(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}`, { title: title.trim(), body });
			setTask(updated);
			setEditing(false);
			await load();
		} finally {
			setSaving(false);
		}
	}

	async function startRun(lane: UserRunLane) {
		if (!task || isArchived || starting) return;
		const draft = lane === "gate" ? gateMessage : message;
		setStarting(true);
		try {
			const run = await apiPost<AgentRun>(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/runs`, {
				message: draft.trim() || task.body,
				relation: "parallel",
				lane,
			});
			if (lane === "gate") setGateMessage("");
			else setMessage("");
			navigate(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.id)}`);
		} finally {
			setStarting(false);
		}
	}

	async function checkpoint() {
		if (!task || isArchived || checkpointing) return;
		setCheckpointing(true);
		try {
			await runAfterMarkDoneSuccess({
				mutation: () =>
					apiPost(
						`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/checkpoints`,
						{},
					),
				navigate: (href) => navigate(href, { replace: true }),
				projectId,
				taskId: task.id,
				task,
				afterSuccess: load,
			});
		} finally {
			setCheckpointing(false);
		}
	}

	async function startGraphAgent(mode: "task_runs" | "gate_runs" | "ship_prep") {
		if (!task || isArchived || graphing || activeGraphRun) return;
		setGraphing(true);
		setGraphError("");
		try {
			await apiPost<AgentRun>(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/graph-agent`, { mode });
			await load();
		} catch (nextError) {
			setGraphError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setGraphing(false);
		}
	}

	if (loading && !task)
		return <section className="home-page route-state-page"><div className="home-empty"><BusyIndicator label="Loading task" /></div></section>;
	if (error)
		return (
			<section className="home-page route-state-page">
				<div className="home-empty">
					<h3>Invalid task route</h3>
					<p>{error}</p>
					<Link to="/">Back to graph</Link>
				</div>
			</section>
		);
	if (!task) return null;

	return (
		<section className="home-run-fullscreen task-route-page">
			<header className="home-run-topbar">
				<button type="button" className="back-button" onClick={() => navigate(`/projects/${encodeURIComponent(projectId)}`)}>← Graph</button>
				<div className="home-run-title">
					<small>Task · worktree: {worktreeName(worktree)}</small>
					<h2>{task.title}</h2>
				</div>
				<div className="home-run-topbar-actions">
					{isArchived ? <span className="task-status status-done">Archived</span> : null}
					<span className={`task-status status-${task.status}`}>{labelStatus(task.status)}</span>
					{worktree && !isArchived ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktree.id)}/diffs`}>View Diffs</Link> : null}
					{!isArchived ? <Link className="home-action-link" to={worktree ? `/projects/${encodeURIComponent(projectId)}/annotations?${new URLSearchParams({ worktreeId: worktree.id })}` : `/projects/${encodeURIComponent(projectId)}/annotations`}>Annotations</Link> : null}
					<Link className="home-action-link" to={isArchived ? `/projects/${encodeURIComponent(projectId)}/history` : `/projects/${encodeURIComponent(projectId)}`}>{isArchived ? "History" : "Graph"}</Link>
					{!isArchived ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/checkpoint`}>Gate</Link> : null}
					{!isArchived ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/ship`}>Ship</Link> : null}
					{!isArchived ? <button type="button" disabled={!canCheckpoint || checkpointing} onClick={() => void checkpoint()}>{checkpointing ? "Marking…" : "Mark gate"}</button> : null}
				</div>
			</header>
			<div className="task-route-body">
				<section className="card task-route-editor">
					<div className="panel-head task-route-section-head">
						<div>
							<h2>Task brief</h2>
							<small>{editing ? "Editing with live preview" : "Markdown rendered"}</small>
						</div>
						{editing || isArchived ? null : <button type="button" onClick={() => setEditing(true)}>Edit</button>}
					</div>
					{editing ? (
						<form className="home-form task-route-edit-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
							<label>
								Title
								<input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
							</label>
							<label>
								Details
								<textarea value={body} onChange={(event) => setBody(event.target.value)} />
							</label>
							<div className="task-route-live-preview">
								<small>Live preview</small>
								<h3>{title || "Untitled task"}</h3>
								<MarkdownText text={body || "No details."} />
							</div>
							<div className="home-modal-actions">
								<button type="button" onClick={() => { setTitle(task.title); setBody(task.body); setEditing(false); }}>Cancel</button>
								<button type="submit" disabled={!title.trim() || saving}>{saving ? "Saving…" : "Save task"}</button>
							</div>
						</form>
					) : (
						<div className="task-route-markdown">
							<h2>{task.title}</h2>
							<MarkdownText text={task.body || "No details."} />
						</div>
					)}
				</section>
				{isArchived ? <section className="card"><p className="empty-state">Archived task. Runs and ship evidence remain read-only in History.</p></section> : null}
				<section className="card task-route-runs">
					<div className="panel-head task-route-section-head">
						<div>
							<h2>Runs</h2>
							<small>{taskLaneRuns.length} task lane · {gateRuns.length} gate lane · {graphRuns.length} automation</small>
						</div>
						<div className="task-route-head-actions">
							{loading ? <BusyIndicator label="Syncing" /> : null}
							<button type="button" disabled={isArchived || graphing || activeGraphRun} onClick={() => void startGraphAgent("task_runs")}>{graphing ? "Starting…" : activeGraphRun ? "Automation running" : "Auto Create Runs"}</button>
						</div>
					</div>
					{graphError ? <p className="error graph-agent-error">{graphError}</p> : null}
					<section className="task-route-lane">
						<div className="task-route-lane-head">
							<div>
								<h3>Task lane</h3>
								<small>Runs before gate.</small>
							</div>
						</div>
						{!isArchived ? (
							<div className="task-route-start-run">
								<textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="New task-lane run instructions…" />
								<button type="button" disabled={starting} onClick={() => void startRun("task")}>{starting ? "Starting…" : "New task run"}</button>
							</div>
						) : null}
						<div className="task-route-run-list">
							{taskLaneRuns.map((run) => (
								<Link key={run.id} to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.id)}`} className="task-route-run-row">
									<strong>{run.request || run.mainAgentName || run.id}</strong>
									<span className={`task-status status-${run.status}`}>{labelStatus(run.status)}</span>
								</Link>
							))}
							{!taskLaneRuns.length ? <p className="empty-state">No task-lane runs yet.</p> : null}
						</div>
					</section>
					{graphRuns.length ? (
						<section className="task-route-lane graph-lane">
							<div className="task-route-lane-head">
								<div>
									<h3>Graph automation</h3>
									<small>Internal automation orchestration runs.</small>
								</div>
							</div>
							<div className="task-route-run-list">
								{graphRuns.map((run) => (
									<Link key={run.id} to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.id)}`} className="task-route-run-row graph-run-row">
										<strong>{run.mainAgentName || run.id}</strong>
										<span className={`task-status status-${run.status}`}>{labelStatus(run.status)}</span>
									</Link>
								))}
							</div>
						</section>
					) : null}
					<section className="task-route-lane gate-lane">
						<div className="task-route-lane-head">
							<div>
								<h3>Gate lane</h3>
								<small>Gate analysis runs before Ship.</small>
							</div>
							<Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/checkpoint`}>Open gate</Link>
						</div>
						{!isArchived ? (
							<div className="task-route-start-run">
								<textarea value={gateMessage} onChange={(event) => setGateMessage(event.target.value)} placeholder="New gate-lane run instructions…" />
								<button type="button" disabled={starting} onClick={() => void startRun("gate")}>{starting ? "Starting…" : "New gate run"}</button>
							</div>
						) : null}
						<div className="task-route-run-list">
							{gateRuns.map((run) => (
								<Link key={run.id} to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.id)}`} className="task-route-run-row gate-run-row">
									<strong>{run.request || run.mainAgentName || run.id}</strong>
									<span className={`task-status status-${run.status}`}>{labelStatus(run.status)}</span>
								</Link>
							))}
							{!gateRuns.length ? <p className="empty-state">No gate-lane runs yet.</p> : null}
						</div>
					</section>
				</section>
			</div>
		</section>
	);
}
