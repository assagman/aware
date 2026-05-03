import type { AgentRun, Task, TaskStatus } from "@aware/shared";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPatch, apiPost } from "../app/api";
import { getPageState, setPageState } from "../app/pageState";
import {
	getSelection,
	setSelectedRunId,
	setSelectedTaskId,
} from "../app/selection";
import { AgentPicker } from "../components/AgentPicker";
import { WorktreeSelect } from "../components/WorktreeSelect";

type TaskFilter = "active" | "done" | "all";
type TaskSort = "status-updated" | "updated" | "title";

const statusOrder: Record<TaskStatus, number> = {
	running: 0,
	queued: 1,
	failed: 2,
	draft: 3,
	done: 4,
};

const initialTasksState = getPageState("tasks", {
	title: "",
	body: "",
	selectedTaskId: "",
	agentProfileId: "",
	taskFilter: "active" as TaskFilter,
	taskSort: "status-updated" as TaskSort,
	worktreeId: "",
});

export function TasksPage() {
	const [tasks, setTasks] = useState<Task[]>([]);
	const [projectId, setProjectId] = useState("");
	const [title, setTitle] = useState(initialTasksState.title);
	const [body, setBody] = useState(initialTasksState.body);
	const [taskWorktreeId, setTaskWorktreeId] = useState(
		initialTasksState.worktreeId,
	);
	const [selectedTaskId, setSelectedTaskIdState] = useState(
		getSelection().selectedTaskId || initialTasksState.selectedTaskId,
	);
	const [agentProfileId, setAgentProfileId] = useState(
		initialTasksState.agentProfileId,
	);
	const [taskFilter, setTaskFilter] = useState<TaskFilter>(
		initialTasksState.taskFilter,
	);
	const [taskSort, setTaskSort] = useState<TaskSort>(
		initialTasksState.taskSort,
	);
	const load = () => {
		const selectedProjectId = getSelection().selectedProjectId;
		setProjectId(selectedProjectId);
		if (!selectedProjectId) {
			setTasks([]);
			return;
		}
		void apiGet<Task[]>(
			`/tasks?${new URLSearchParams({ projectId: selectedProjectId })}`,
		).then(setTasks);
	};
	useEffect(() => {
		const reloadSelection = () => load();
		load();
		window.addEventListener("aware-selection", reloadSelection);
		return () => window.removeEventListener("aware-selection", reloadSelection);
	}, []);
	const visibleTasks = useMemo(() => {
		return tasks
			.filter((task) => {
				if (task.archivedAt || task.deletedAt) return false;
				if (taskFilter === "active") return task.status !== "done";
				if (taskFilter === "done") return task.status === "done";
				return true;
			})
			.sort((a, b) => {
				if (taskSort === "updated")
					return b.updatedAt.localeCompare(a.updatedAt);
				if (taskSort === "title") return a.title.localeCompare(b.title);
				return (
					statusOrder[a.status] - statusOrder[b.status] ||
					b.updatedAt.localeCompare(a.updatedAt)
				);
			});
	}, [tasks, taskFilter, taskSort]);
	const selectedTask = tasks.find((task) => task.id === selectedTaskId);
	function newTask() {
		setSelectedTaskIdState("");
		setTitle("");
		setBody("");
		setTaskWorktreeId("");
		setPageState("tasks", {
			selectedTaskId: "",
			title: "",
			body: "",
			worktreeId: "",
		});
	}
	function editTask(task: Task) {
		setSelectedTaskIdState(task.id);
		setSelectedTaskId(task.id);
		setTitle(task.title);
		setBody(task.body);
		setTaskWorktreeId(task.worktreeId ?? "");
		setPageState("tasks", {
			selectedTaskId: task.id,
			title: task.title,
			body: task.body,
			worktreeId: task.worktreeId ?? "",
		});
	}
	function chooseTaskWorktree(id: string) {
		setTaskWorktreeId(id);
		setPageState("tasks", { worktreeId: id });
	}
	async function save() {
		if (!projectId || !title.trim()) return;
		const patch = { title, body, worktreeId: taskWorktreeId || null };
		if (selectedTaskId) {
			await apiPatch<Task>(`/tasks/${selectedTaskId}`, patch);
			load();
			return;
		}
		const task = await apiPost<Task>("/tasks", { projectId, ...patch });
		setSelectedTaskId(task.id);
		setSelectedTaskIdState(task.id);
		setPageState("tasks", { selectedTaskId: task.id });
		load();
	}
	async function start(id: string) {
		const task = tasks.find((t) => t.id === id);
		const run = await apiPost<AgentRun>(`/tasks/${id}/start`, {
			agentProfileId,
			worktreeId: task?.worktreeId,
		});
		setSelectedRunId(run.id);
		load();
		alert(`run ${run.id}`);
	}
	async function softUpdate(id: string, patch: Partial<Task>) {
		await apiPatch<Task>(`/tasks/${id}`, patch);
		newTask();
		load();
	}
	const hasSelection = Boolean(projectId);
	return (
		<section id="tasks" className="card tasks-page">
			<div className="tasks-header">
				<div>
					<h2>Tasks</h2>
					<p>
						Project tasks. Attach worktree in task details; default is new
						worktree.
					</p>
				</div>
				<AgentPicker
					value={agentProfileId}
					onChange={(id) => {
						setAgentProfileId(id);
						setPageState("tasks", { agentProfileId: id });
					}}
				/>
			</div>
			{!hasSelection ? (
				<p className="tasks-empty">
					Select project from top-right picker to manage tasks.
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
						<div>
							<h3>{selectedTaskId ? "Edit task" : "New task"}</h3>
							{selectedTask ? (
								<span className={`task-status status-${selectedTask.status}`}>
									{selectedTask.status}
								</span>
							) : null}
						</div>
						<div className="task-detail-actions">
							{selectedTask ? (
								<>
									<button
										type="button"
										onClick={() =>
											void softUpdate(selectedTask.id, {
												archivedAt: new Date().toISOString(),
											})
										}
									>
										Archive
									</button>
									<button
										type="button"
										onClick={() =>
											void softUpdate(selectedTask.id, {
												deletedAt: new Date().toISOString(),
											})
										}
									>
										Delete
									</button>
								</>
							) : null}
							<button type="button" onClick={newTask}>
								New
							</button>
						</div>
					</div>
					<label>
						Title
						<input
							value={title}
							onChange={(e) => {
								setTitle(e.target.value);
								setPageState("tasks", { title: e.target.value });
							}}
							placeholder="Task title"
						/>
					</label>
					<WorktreeSelect
						value={taskWorktreeId}
						onChange={chooseTaskWorktree}
						label="Task worktree"
						placeholder="new worktree"
						excludeDefaultBranches
					/>
					<p className="task-worktree-note">
						{taskWorktreeId
							? "Agent will use this attached worktree."
							: "Worktree agent will create /workspace/<category>/<slug> before run start."}
					</p>
					<label className="task-body-field">
						Details
						<textarea
							value={body}
							onChange={(e) => {
								setBody(e.target.value);
								setPageState("tasks", { body: e.target.value });
							}}
							placeholder="Describe the work to be done..."
						/>
					</label>
					<div className="task-composer-actions">
						<button type="submit" disabled={!hasSelection || !title.trim()}>
							{selectedTaskId ? "Save changes" : "Create task"}
						</button>
					</div>
				</form>
				<div className="tasks-list-panel">
					<div className="tasks-list-tools">
						<label>
							Filter
							<select
								value={taskFilter}
								onChange={(e) => {
									setTaskFilter(e.target.value as TaskFilter);
									setPageState("tasks", { taskFilter: e.target.value });
								}}
							>
								<option value="active">Not done</option>
								<option value="done">Done</option>
								<option value="all">All active</option>
							</select>
						</label>
						<label>
							Sort
							<select
								value={taskSort}
								onChange={(e) => {
									setTaskSort(e.target.value as TaskSort);
									setPageState("tasks", { taskSort: e.target.value });
								}}
							>
								<option value="status-updated">Status, updated</option>
								<option value="updated">Updated time</option>
								<option value="title">Title</option>
							</select>
						</label>
					</div>
					<div className="tasks-list" aria-label="Tasks list">
						{visibleTasks.length === 0 ? (
							<p className="tasks-empty">No tasks match current filters.</p>
						) : null}
						{visibleTasks.map((t) => {
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
										<small>
											{t.worktreeId ? "attached worktree" : "new worktree"}
										</small>
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
						})}
					</div>
				</div>
			</div>
		</section>
	);
}
