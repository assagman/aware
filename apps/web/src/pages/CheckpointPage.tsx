import type { AgentRun, GraphProjection, Task, Worktree } from "@aware/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { API_BASE, apiGet, apiPost } from "../app/api";
import { BusyIndicator } from "../components/BusyIndicator";

const ANALYSIS_PROMPTS = [
	["Code Review", "Review the current worktree changes. Focus on correctness, maintainability, edge cases, and regression risk. Do not modify files; report findings with file paths."],
	["Code Complexity", "Analyze code complexity introduced by the current changes. Find overly complex functions, abstractions, and control flow. Do not modify files; report ranked risks."],
	["Code Smell", "Find code smells in the current worktree changes: duplication, leaky abstractions, weak names, hidden coupling, and brittle patterns. Do not modify files; report actionable findings."],
	["Huge Files", "Find huge or growing files touched or affected by this task. Identify split opportunities and explain risk. Do not modify files."],
	["Security Audit", "Security-audit the current worktree changes. Look for injection, unsafe IO, auth/authz gaps, secret leaks, path traversal, dependency risk, and unsafe defaults. Do not modify files."],
	["Documentation", "Review whether docs, comments, README, ADRs, and user-facing guidance need updates for the current changes. Do not modify files; report missing docs."],
	["Test Plan", "Derive a focused test plan for the current changes. Include unit, integration, browser, API, and regression checks. Do not modify files."],
	["Performance", "Assess performance risks in the current changes: render churn, IO, DB scans, expensive parsing, and large payloads. Do not modify files."],
	["Accessibility", "Review UI changes for accessibility issues: semantics, focus, keyboard usage, contrast, labels, and screen-reader behavior. Do not modify files."],
	["Release Notes", "Draft concise release notes for this task based on current worktree changes and run history. Do not modify files."],
] as const;

type DiffStats = {
	files: number;
	additions: number;
	deletions: number;
	sections: { label: string; files: number; additions: number; deletions: number }[];
};

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

function statsForPatch(label: string, patch: string) {
	let files = 0;
	let additions = 0;
	let deletions = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) files += 1;
		else if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
	}
	return { label, files, additions, deletions };
}

async function fetchPatch(projectId: string, worktreeId: string, mode: string) {
	const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/diffs?${new URLSearchParams({ mode })}`);
	if (!response.ok) throw new Error(await response.text());
	return response.text();
}

function emptyStats(): DiffStats {
	return { files: 0, additions: 0, deletions: 0, sections: [] };
}

export function CheckpointPage() {
	const navigate = useNavigate();
	const { projectId = "", taskId = "" } = useParams();
	const [task, setTask] = useState<Task | null>(null);
	const [runs, setRuns] = useState<AgentRun[]>([]);
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [stats, setStats] = useState<DiffStats>(emptyStats());
	const [message, setMessage] = useState("");
	const [loading, setLoading] = useState(true);
	const [starting, setStarting] = useState("");
	const [checkpointing, setCheckpointing] = useState(false);
	const [graphing, setGraphing] = useState(false);
	const [error, setError] = useState("");
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
			const worktreeId = nextTask.worktreeId;
			if (worktreeId) {
				const patches = await Promise.all([
					fetchPatch(projectId, worktreeId, "main"),
					fetchPatch(projectId, worktreeId, "staged"),
					fetchPatch(projectId, worktreeId, "unstaged"),
				]);
				const sections = [
					statsForPatch("Committed", patches[0] ?? ""),
					statsForPatch("Staged", patches[1] ?? ""),
					statsForPatch("Unstaged", patches[2] ?? ""),
				];
				setStats({
					files: sections.reduce((sum, row) => sum + row.files, 0),
					additions: sections.reduce((sum, row) => sum + row.additions, 0),
					deletions: sections.reduce((sum, row) => sum + row.deletions, 0),
					sections,
				});
			} else setStats(emptyStats());
			setError("");
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setLoading(false);
		}
	}, [projectId, taskId]);

	useEffect(() => { void load(); }, [load]);

	const worktree = useMemo(() => task?.worktreeId ? worktrees.find((item) => item.id === task.worktreeId) : undefined, [task?.worktreeId, worktrees]);
	const taskRuns = runs.filter((run) => runLane(run) === "task");
	const gateRuns = runs.filter((run) => runLane(run) === "gate");
	const graphRuns = runs.filter((run) => runLane(run) === "graph");
	const activeGraphRun = graphRuns.some((run) => run.status === "running" || run.status === "queued");
	const activeTaskRuns = taskRuns.filter((run) => !run.deletedAt);
	const canCheckpoint = activeTaskRuns.length > 0 && activeTaskRuns.every((run) => run.status === "done");

	async function startGateRun(label: string, prompt: string) {
		if (!task || starting) return;
		setStarting(label);
		try {
			const run = await apiPost<AgentRun>(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/runs`, {
				message: prompt,
				relation: "parallel",
				lane: "gate",
			});
			navigate(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.id)}`);
		} finally {
			setStarting("");
		}
	}

	async function startManualGateRun() {
		if (!message.trim()) return;
		await startGateRun("Manual", message.trim());
		setMessage("");
	}

	async function markCheckpoint() {
		if (!task || checkpointing) return;
		setCheckpointing(true);
		try {
			await apiPost(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/checkpoints`, {});
			await load();
		} finally {
			setCheckpointing(false);
		}
	}

	async function startGraphGateRuns() {
		if (!task || graphing || activeGraphRun) return;
		setGraphing(true);
		setGraphError("");
		try {
			await apiPost<AgentRun>(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/graph-agent`, { mode: "gate_runs" });
			await load();
		} catch (nextError) {
			setGraphError(nextError instanceof Error ? nextError.message : String(nextError));
		} finally {
			setGraphing(false);
		}
	}

	if (loading && !task)
		return <section className="home-page route-state-page"><div className="home-empty"><BusyIndicator label="Loading gate" /></div></section>;
	if (error)
		return (
			<section className="home-page route-state-page">
				<div className="home-empty">
					<h3>Invalid gate route</h3>
					<p>{error}</p>
					<Link to="/">Back to graph</Link>
				</div>
			</section>
		);
	if (!task) return null;

	return (
		<section className="home-run-fullscreen checkpoint-route-page">
			<header className="home-run-topbar">
				<button type="button" className="back-button" onClick={() => navigate(`/projects/${encodeURIComponent(projectId)}`)}>← Graph</button>
				<div className="home-run-title">
					<small>Gate · {worktreeName(worktree)}</small>
					<h2>{task.title}</h2>
				</div>
				<div className="home-run-topbar-actions">
					<Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}`}>Task</Link>
					{worktree ? <Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktree.id)}/diffs`}>Diffs</Link> : null}
					<Link className="home-action-link" to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}/ship`}>Ship</Link>
					<button type="button" disabled={!canCheckpoint || checkpointing} onClick={() => void markCheckpoint()}>{checkpointing ? "Marking…" : "Mark gate"}</button>
				</div>
			</header>
			<div className="checkpoint-route-body">
				<section className="checkpoint-grid">
					<article className="card checkpoint-card">
						<h3>Change stats</h3>
						<strong>{stats.files} files</strong>
						<p><span>+{stats.additions}</span> <span>-{stats.deletions}</span></p>
					</article>
					<article className="card checkpoint-card">
						<h3>Task lane</h3>
						<strong>{activeTaskRuns.filter((run) => run.status === "done").length}/{activeTaskRuns.length}</strong>
						<p>done before gate</p>
					</article>
					<article className="card checkpoint-card">
						<h3>Gate lane</h3>
						<strong>{gateRuns.length}</strong>
						<p>analysis runs before Ship</p>
					</article>
					<article className="card checkpoint-card">
						<h3>Graph Agent</h3>
						<strong>{activeGraphRun ? "Running" : graphRuns.length}</strong>
						<p>automation runs</p>
					</article>
				</section>
				<section className="card checkpoint-card checkpoint-wide">
					<div className="panel-head">
						<div>
							<h2>Version-control status</h2>
							<small>Committed, staged, unstaged change split.</small>
						</div>
						{loading ? <BusyIndicator label="Refreshing" /> : null}
					</div>
					<div className="checkpoint-stats-table">
						{stats.sections.map((row) => (
							<div key={row.label}>
								<strong>{row.label}</strong>
								<span>{row.files} files</span>
								<span>+{row.additions}</span>
								<span>-{row.deletions}</span>
							</div>
						))}
						{!stats.sections.length ? <p className="empty-state">No worktree diff available.</p> : null}
					</div>
				</section>
				<section className="card checkpoint-card checkpoint-wide">
					<div className="panel-head">
						<div>
							<h2>LLM analysis buttons</h2>
							<small>Starts gate-lane parallel runs connected to Ship.</small>
						</div>
						<button type="button" disabled={graphing || activeGraphRun} onClick={() => void startGraphGateRuns()}>{graphing ? "Starting…" : activeGraphRun ? "Graph Agent running" : "Auto Gate Runs"}</button>
					</div>
					{graphError ? <p className="error graph-agent-error">{graphError}</p> : null}
					<div className="checkpoint-analysis-grid">
						{ANALYSIS_PROMPTS.map(([label, prompt]) => (
							<button key={label} type="button" disabled={Boolean(starting)} onClick={() => void startGateRun(label, prompt)}>
								{starting === label ? "Starting…" : label}
							</button>
						))}
					</div>
					<div className="task-route-start-run checkpoint-manual-run">
						<textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Custom gate analysis prompt…" />
						<button type="button" disabled={!message.trim() || Boolean(starting)} onClick={() => void startManualGateRun()}>{starting === "Manual" ? "Starting…" : "Start gate run"}</button>
					</div>
				</section>
				<section className="card checkpoint-card checkpoint-wide">
					<div className="panel-head">
						<div>
							<h2>Gate runs</h2>
							<small>Gate downstream until Ship.</small>
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
						{!gateRuns.length ? <p className="empty-state">No gate runs yet.</p> : null}
					</div>
				</section>
			</div>
		</section>
	);
}
