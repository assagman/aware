import type { AgentRun, Task } from "@agent-ide/shared";
import { useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost } from "../app/api";
import {
	getSelection,
	setSelectedRunId,
	setSelectedTaskId,
} from "../app/selection";
import { AgentPicker } from "../components/AgentPicker";

export function TasksPage() {
	const [tasks, setTasks] = useState<Task[]>([]);
	const [projectId, setProjectId] = useState("");
	const [worktreeId, setWorktreeId] = useState("");
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [selectedTaskId, setSelectedTaskIdState] = useState("");
	const [agentProfileId, setAgentProfileId] = useState("");
	const load = () => {
		const selection = getSelection();
		const selectedProjectId = selection.selectedProjectId;
		const selectedWorktreeId = selection.selectedWorktreeId;
		setProjectId(selectedProjectId);
		setWorktreeId(selectedWorktreeId);
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
		const reloadSelection = () => {
			newTask();
			load();
		};
		reload();
		window.addEventListener("agent-ide-selection", reloadSelection);
		return () => window.removeEventListener("agent-ide-selection", reloadSelection);
	}, []);
	function newTask() {
		setSelectedTaskIdState("");
		setTitle("");
		setBody("");
	}
	function editTask(task: Task) {
		setSelectedTaskIdState(task.id);
		setSelectedTaskId(task.id);
		setTitle(task.title);
		setBody(task.body);
	}
	async function save() {
		if (!projectId || !worktreeId || !title.trim()) return;
		if (selectedTaskId) {
			await apiPatch<Task>(`/tasks/${selectedTaskId}`, { title, body });
			load();
			return;
		}
		const task = await apiPost<Task>("/tasks", {
			projectId,
			worktreeId,
			title,
			body,
		});
		setSelectedTaskId(task.id);
		setSelectedTaskIdState(task.id);
		load();
	}
	async function start(id: string) {
		const run = await apiPost<AgentRun>(`/tasks/${id}/start`, {
			agentProfileId,
		});
		setSelectedRunId(run.id);
		load();
		alert(`run ${run.id}`);
	}
	const hasSelection = Boolean(projectId && worktreeId);
	return (
		<section id="tasks" className="card tasks-page">
			<div className="tasks-header">
				<div>
					<h2>Tasks</h2>
					<p>Create and run tasks for the selected project/worktree.</p>
				</div>
				<AgentPicker value={agentProfileId} onChange={setAgentProfileId} />
			</div>
			{!hasSelection ? (
				<p className="tasks-empty">
					Select a project and worktree from the top-right pickers to manage
					tasks.
				</p>
			) : null}
			<div className="tasks-layout">
				<form
					className="task-composer"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<div className="task-composer-head">
						<h3>{selectedTaskId ? "Edit task" : "New task"}</h3>
						<button type="button" onClick={newTask}>
							New
						</button>
					</div>
					<label>
						Title
						<input
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="Task title"
						/>
					</label>
					<label className="task-body-field">
						Details
						<textarea
							value={body}
							onChange={(e) => setBody(e.target.value)}
							placeholder="Describe the work to be done..."
						/>
					</label>
					<div className="task-composer-actions">
						<button type="submit" disabled={!hasSelection || !title.trim()}>
							{selectedTaskId ? "Save changes" : "Create task"}
						</button>
					</div>
				</form>
				<div className="tasks-list" aria-label="Tasks list">
					{tasks.length === 0 ? (
						<p className="tasks-empty">No tasks yet for this selection.</p>
					) : (
						tasks.map((t) => {
							const canStart = t.status !== "done" && t.status !== "running";
							return (
								<article
									key={t.id}
									className={
										selectedTaskId === t.id ? "task-row selected" : "task-row"
									}
									role="button"
									tabIndex={0}
									onClick={() => editTask(t)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") editTask(t);
									}}
								>
									<div className="task-row-main">
										<strong>{t.title}</strong>
										{t.body ? <p>{t.body}</p> : null}
									</div>
									<div className="task-row-actions">
										<span className={`task-status status-${t.status}`}>
											{t.status}
										</span>
										{canStart ? (
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													void start(t.id);
												}}
											>
												Start
											</button>
										) : null}
									</div>
								</article>
							);
						})
					)}
				</div>
			</div>
		</section>
	);
}
