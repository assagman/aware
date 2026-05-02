import type { AgentRun, Project, Task, Worktree } from "@agent-ide/shared";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../app/api";
import { setSelectedRunId, setSelectedTaskId } from "../app/selection";

export function TasksPage() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [tasks, setTasks] = useState<Task[]>([]);
	const [projectId, setProjectId] = useState("");
	const [worktreeId, setWorktreeId] = useState("");
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const load = () => {
		void apiGet<Project[]>("/projects").then(setProjects);
		void apiGet<Worktree[]>("/worktrees").then(setWorktrees);
		void apiGet<Task[]>("/tasks").then(setTasks);
	};
	useEffect(load, []);
	async function create() {
		const task = await apiPost<Task>("/tasks", {
			projectId,
			worktreeId,
			title,
			body,
		});
		setSelectedTaskId(task.id);
		load();
	}
	async function start(id: string) {
		const run = await apiPost<AgentRun>(`/tasks/${id}/start`, {});
		setSelectedRunId(run.id);
		load();
		alert(`run ${run.id}`);
	}
	return (
		<section id="tasks" className="card">
			<h2>Tasks</h2>
			<select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
				<option value="">project</option>
				{projects.map((p) => (
					<option key={p.id} value={p.id}>
						{p.name}
					</option>
				))}
			</select>
			<select
				value={worktreeId}
				onChange={(e) => setWorktreeId(e.target.value)}
			>
				<option value="">worktree</option>
				{worktrees.map((w) => (
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
			<button type="button" onClick={create}>
				Create task
			</button>
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
