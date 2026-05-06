import type { AgentRun, GraphProjection, Task, Worktree } from "@aware/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../app/api";
import { BusyIndicator } from "../components/BusyIndicator";

function labelStatus(status: string) {
	return status.replace(/_/g, " ");
}

function runLane(run: AgentRun) {
	return run.lane === "gate" || run.lane === "ship" || run.lane === "graph" ? run.lane : "task";
}

function worktreeName(worktree: Worktree | undefined) {
	if (!worktree) return "?";
	return worktree.branch || worktree.path.split("/").filter(Boolean).at(-1) || worktree.path;
}

function isActive(run: AgentRun | undefined) {
	return run?.status === "running" || run?.status === "queued";
}

function isTerminalShippingRun(run: AgentRun | undefined) {
	return run?.status === "need_review" || run?.status === "done";
}

export function ShippingPage() {
	const navigate = useNavigate();
	const { projectId = "", taskId = "" } = useParams();
	const [task, setTask] = useState<Task | null>(null);
	const [runs, setRuns] = useState<AgentRun[]>([]);
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [loading, setLoading] = useState(true);
	const [shipping, setShipping] = useState(false);
	const [graphing, setGraphing] = useState(false);
	const [error, setError] = useState("");
	const [shipError, setShipError] = useState("");
	const [graphError, setGraphError] = useState("");

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const [nextTask, graph] = await Promise.all([
				apiGet<Task>(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`),
				apiGet<GraphProjection>(`/projects/${encodeURIComponent(projectId)}/graph`),
			]);
			setTask(nextTask);
			setRuns(graph.runs.filter((run) => run.taskId === nextTask.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
			setWorktrees(graph.worktrees);
			setError("");
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setLoading(false);
		}
	}, [projectId, taskId]);

	useEffect(() => { void load(); }, [load]);

	const worktree = useMemo(() => task?.worktreeId ? worktrees.find((item) => item.id === task.worktreeId) : undefined, [task?.worktreeId, worktrees]);
	const gateRuns = runs.filter((run) => runLane(run) === "gate" && !run.deletedAt);
	const taskRuns = runs.filter((run) => runLane(run) === "task" && !run.deletedAt);
	const shipRuns = runs.filter((run) => runLane(run) === "ship" && !run.deletedAt);
	const graphRuns = runs.filter((run) => runLane(run) === "graph" && !run.deletedAt);
	const activeGraphRun = graphRuns.some(isActive);
	const activeShipRun = shipRuns.find(isActive);
	const terminalShipRun = shipRuns.find(isTerminalShippingRun);
	const gateReady = gateRuns.length === 0 || gateRuns.every((run) => run.status === "done");
	const taskReady = taskRuns.length > 0 && taskRuns.every((run) => run.status === "done");
	const shipActive = Boolean(activeShipRun);
	const shipLocked = Boolean(terminalShipRun);
	const readyToShip = Boolean(worktree) && taskReady && gateReady;
	const canStartShip = readyToShip && !shipActive && !shipLocked && !shipping;
	const shipStatus = !worktree ? "No worktree" : shipActive ? "Shipping" : shipLocked ? "Shipped" : readyToShip ? "Ready" : "Blocked";
	const shipBlocker = !worktree
		? "Task has no worktree."
		: !taskReady
			? "Task lane must be done."
			: !gateReady
				? "Gate lane must be done or intentionally skipped."
				: shipActive
					? "Shipping Agent run already active."
					: shipLocked
						? "Shipping Agent run already exists. Review it in run history."
						: "Ready.";

	async function startShipping() {
		if (!task || !canStartShip) return;
		setShipping(true);
		setShipError("");
		try {
			const run = await apiPost<AgentRun>(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/ship`, {});
			navigate(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.id)}`);
		} catch (nextError) {
			setShipError(nextError instanceof Error ? nextError.message : String(nextError));
			await load();
		} finally {
			setShipping(false);
		}
	}

	async function startShipPrep() {
		if (!task || graphing || activeGraphRun) return;
		setGraphing(true);
		setGraphError("");
		try {
			await apiPost<AgentRun>(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/graph-agent`, { mode: "ship_prep" });
			await load();
		} catch (nextError) {
			setGraphError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setGraphing(false);
		}
	}

	if (loading && !task)
		return <section className="home-page route-state-page"><div className="home-empty"><BusyIndicator label="Loading ship gate" /></div></section>;
	if (error)
		return (
			<section className="home-page route-state-page">
				<div className="home-empty">
					<h3>Invalid ship route</h3>
					<p>{error}</p>
					<Link to="/">Back to graph</Link>
				</div>
			</section>
		);
	if (!task) return null;

	return (
		<section className="home-run-fullscreen shipping-route-page">
			<header className="home-run-topbar">
				<button type="button" className="back-button" onClick={() => navigate(`/projects/${encodeURIComponent(projectId)}`)}>← Graph</button>
				<div className="home-run-title">
					<small>Ship · {worktreeName(worktree)}</small>
					<h2>{task.title}</h2>
				</div>
				<div className="home-run-topbar-actions">
					<Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}`}>Task</Link>
					<Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/checkpoint`}>Gate</Link>
					{worktree ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktree.id)}/files`}>Files</Link> : null}
					{worktree ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktree.id)}/diffs`}>Diffs</Link> : null}
					<button type="button" onClick={() => void load()}>Refresh</button>
				</div>
			</header>
			<div className="shipping-route-body">
				<section className="checkpoint-grid">
					<article className="card checkpoint-card">
						<h3>Task lane</h3>
						<strong>{taskRuns.filter((run) => run.status === "done").length}/{taskRuns.length}</strong>
						<p>{taskReady ? "ready" : "not ready"}</p>
					</article>
					<article className="card checkpoint-card">
						<h3>Gate lane</h3>
						<strong>{gateRuns.filter((run) => run.status === "done").length}/{gateRuns.length}</strong>
						<p>{gateReady ? "ready" : "needs review"}</p>
					</article>
					<article className="card checkpoint-card">
						<h3>Ship status</h3>
						<strong>{shipStatus}</strong>
						<p>{shipBlocker}</p>
					</article>
					<article className="card checkpoint-card">
						<h3>Graph Agent</h3>
						<strong>{activeGraphRun ? "Running" : graphRuns.length}</strong>
						<p>ship-prep automation</p>
					</article>
				</section>
				<section className="card checkpoint-card checkpoint-wide shipping-control-card">
					<div className="panel-head">
						<div>
							<h2>Shipping Agent</h2>
							<small>One final run handles commit, rebase, PR, merge, cleanup, and default sync.</small>
						</div>
						<div className="task-route-head-actions">
							{loading ? <BusyIndicator label="Refreshing" /> : null}
							<button type="button" disabled={graphing || activeGraphRun || shipActive || shipLocked} onClick={() => void startShipPrep()}>{graphing ? "Starting…" : activeGraphRun ? "Graph Agent running" : "Auto Ship Prep"}</button>
						</div>
					</div>
					<button type="button" className="ship-primary-button" disabled={!canStartShip} onClick={() => void startShipping()}>
						<span>Ship</span>
						<small>{shipping ? "Launching Shipping Agent…" : shipBlocker}</small>
					</button>
					{shipError ? <p className="error ship-error">{shipError}</p> : null}
					{graphError ? <p className="error graph-agent-error">{graphError}</p> : null}
				</section>
				<section className="card checkpoint-card checkpoint-wide">
					<div className="panel-head">
						<div>
							<h2>Ship checklist</h2>
							<small>Run by ShippingPage, not outside UI.</small>
						</div>
					</div>
					<ul className="ship-checklist">
						<li>Commit remaining changes group by group with signed atomic commits.</li>
						<li>Rebase onto default branch, then push current branch to origin.</li>
						<li>Resolve origin host and create PR via gh or tea.</li>
						<li>Merge PR, cleanup remote/local branch and worktree.</li>
						<li>Switch default worktree and pull latest changes.</li>
					</ul>
				</section>
				<section className="card checkpoint-card checkpoint-wide">
					<div className="panel-head">
						<div>
							<h2>Ship run history</h2>
							<small>Internal Shipping Agent final runs.</small>
						</div>
					</div>
					<div className="task-route-run-list">
						{shipRuns.map((run) => (
							<Link key={run.id} to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.id)}`} className="task-route-run-row ship-run-row">
								<strong>{run.request || run.mainAgentName || run.id}</strong>
								<span className={`task-status status-${run.status}`}>{labelStatus(run.status)}</span>
							</Link>
						))}
						{!shipRuns.length ? <p className="empty-state">No ship run yet. Press Ship when ready.</p> : null}
					</div>
				</section>
				<section className="card checkpoint-card checkpoint-wide">
					<div className="panel-head">
						<div>
							<h2>Gate run evidence</h2>
							<small>Runs connected to Ship node.</small>
						</div>
					</div>
					<div className="task-route-run-list">
						{graphRuns.map((run) => (
							<Link key={run.id} to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.id)}`} className="task-route-run-row graph-run-row">
								<strong>{run.mainAgentName || run.id}</strong>
								<span className={`task-status status-${run.status}`}>{labelStatus(run.status)}</span>
							</Link>
						))}
						{gateRuns.map((run) => (
							<Link key={run.id} to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.id)}`} className="task-route-run-row gate-run-row">
								<strong>{run.request || run.mainAgentName || run.id}</strong>
								<span className={`task-status status-${run.status}`}>{labelStatus(run.status)}</span>
							</Link>
						))}
						{!gateRuns.length ? <p className="empty-state">No gate evidence yet. Use Gate to start analysis runs or intentionally skip gate.</p> : null}
					</div>
				</section>
			</div>
		</section>
	);
}
