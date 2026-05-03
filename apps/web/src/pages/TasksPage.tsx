import type { AgentRun, Project, Task, Worktree } from "@agent-ide/shared";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../app/api";
import {
	getSelection,
	setSelectedProjectId,
	setSelectedRunId,
	setSelectedTaskId,
	setSelectedWorktreeId,
} from "../app/selection";
import { AgentPicker } from "../components/AgentPicker";

export function TasksPage() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [tasks, setTasks] = useState<Task[]>([]);
	const [projectId, setProjectId] = useState("");
	const [worktreeId, setWorktreeId] = useState("");
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [agentProfileId, setAgentProfileId] = useState("");
	const filteredWorktrees = worktrees.filter(
		(w) => !projectId || w.projectId === projectId,
	);
	const load = (nextProjectId?: string, nextWorktreeId?: string) => {
		const selection = getSelection();
		const selectedProjectId = nextProjectId ?? selection.selectedProjectId;
		const selectedWorktreeId = nextWorktreeId ?? selection.selectedWorktreeId;
		setProjectId(selectedProjectId);
		setWorktreeId(selectedWorktreeId);
		void apiGet<Project[]>("/projects").then(setProjects);
		void apiGet<Worktree[]>("/worktrees").then(setWorktrees);
		if (!selectedProjectId || !selectedWorktreeId) {
			setTasks([]);
			return;
		}
		const params = new URLSearchParams({
			projectId: selectedProjectId,
			worktreeId: selectedWorktreeId,
		});
		void apiGet<Task[]>(`/tasks?${params}`).then(setTasks);
	};
	useEffect(() => {
		const reload = () => load();
		reload();
		window.addEventListener("agent-ide-selection", reload);
		return () => window.removeEventListener("agent-ide-selection", reload);
	}, []);
	function chooseProject(id: string) {
		setProjectId(id);
		setWorktreeId("");
		setSelectedProjectId(id);
		load(id, "");
	}
	function chooseWorktree(id: string) {
		setWorktreeId(id);
		setSelectedWorktreeId(id);
		load(projectId, id);
	}
	async function create() {
		const task = await apiPost<Task>("/tasks", {
			projectId,
			worktreeId,
			title,
			body,
		});
		setSelectedTaskId(task.id);
		load(projectId, worktreeId);
	}
	async function start(id: string) {
		const run = await apiPost<AgentRun>(`/tasks/${id}/start`, {
			agentProfileId,
		});
		setSelectedRunId(run.id);
		load(projectId, worktreeId);
		alert(`run ${run.id}`);
	}
	return (
		<section id="tasks" className="card">
			<h2>Tasks</h2>
			<select value={projectId} onChange={(e) => chooseProject(e.target.value)}>
				<option value="">project</option>
				{projects.map((p) => (
					<option key={p.id} value={p.id}>
						{p.name}
					</option>
				))}
			</select>
			<select
				value={worktreeId}
				onChange={(e) => chooseWorktree(e.target.value)}
			>
				<option value="">worktree</option>
				{filteredWorktrees.map((w) => (
					<option key={w.id} value={w.id}>
						{w.branch}
					</option>
				))}
			</select>
			<input
				value={title}
				onChange={(e) => setTitle(e.target.value)}
				placeholder="task title"
			/>
			<textarea
				value={body}
				onChange={(e) => setBody(e.target.value)}
				placeholder="task details"
			/>
			<button
				type="button"
				onClick={create}
				disabled={!projectId || !worktreeId || !title.trim()}
			>
				Create task
			</button>
			<AgentPicker value={agentProfileId} onChange={setAgentProfileId} />
			<ul>
				{tasks.map((t) => {
					const canStart = t.status !== "done" && t.status !== "running";
					return (
						<li key={t.id}>
							{canStart ? (
								<button type="button" onClick={() => start(t.id)}>
									start
								</button>
							) : null}{" "}
							{t.title} — {t.status}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
