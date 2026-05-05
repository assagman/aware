import type { AgentRun, Task, TaskStatus } from "@aware/shared";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPatch, apiPost } from "../app/api";
import { getPageState, setPageState } from "../app/pageState";
import {
	getSelectedProjectId,
	getSelection,
	setSelectedProjectId,
	setSelectedRunId,
	setSelectedTaskId,
	setSelectedWorktreeId,
} from "../app/selection";
import { BusyIndicator } from "../components/BusyIndicator";
import { RunLink } from "../components/RunLink";
import { WorktreeSelect } from "../components/WorktreeSelect";

type TaskFilter = "active" | "done" | "all";
type TaskSort = "status-updated" | "updated" | "title";

const statusOrder: Record<TaskStatus, number> = {
	running: 0,
	need_review: 1,
	queued: 2,
	failed: 3,
	draft: 4,
	done: 5,
};

function statusLabel(status: TaskStatus) {
	return status.replace(/_/g, " ");
}

const initialTasksState = getPageState("tasks", {
	title: "",
	body: "",
	selectedTaskId: "",
	taskFilter: "active" as TaskFilter,
	taskSort: "status-updated" as TaskSort,
	worktreeId: "",
});

export function TasksPage() {
	const [tasks, setTasks] = useState<Task[]>([]);
	const [runs, setRuns] = useState<AgentRun[]>([]);
	const [projectId, setProjectIdState] = useState(getSelectedProjectId("tasks"));
	const [title, setTitle] = useState(initialTasksState.title);
	const [body, setBody] = useState(initialTasksState.body);
	const [taskWorktreeId, setTaskWorktreeId] = useState(
		initialTasksState.worktreeId,
	);
	const [selectedTaskId, setSelectedTaskIdState] = useState(
		getSelection().selectedTaskId || initialTasksState.selectedTaskId,
	);
	const [taskFilter, setTaskFilter] = useState<TaskFilter>(
		initialTasksState.taskFilter,
	);
	const [taskSort, setTaskSort] = useState<TaskSort>(
		initialTasksState.taskSort,
	);
	const [loadingTasks, setLoadingTasks] = useState(false);
	const [savingTask, setSavingTask] = useState(false);
	const [startingTaskId, setStartingTaskId] = useState("");
	const load = (nextProjectId = projectId) => {
		if (!nextProjectId) {
			setTasks([]);
			setRuns([]);
			setLoadingTasks(false);
			return;
		}
		setLoadingTasks(true);
		void Promise.all([
			apiGet<Task[]>(
				`/tasks?${new URLSearchParams({ projectId: nextProjectId })}`,
			),
			apiGet<AgentRun[]>("/runs?worktreeId=all"),
		])
			.then(([nextTasks, nextRuns]) => {
				setTasks(nextTasks);
				const taskIds = new Set(nextTasks.map((task) => task.id));
				setRuns(nextRuns.filter((run) => taskIds.has(run.taskId)));
			})
			.finally(() => setLoadingTasks(false));
	};
	useEffect(() => {
		load(projectId);
	}, [projectId]);
	useEffect(() => {
		const syncSelection = () => {
			const nextProjectId = getSelectedProjectId("tasks");
			if (nextProjectId !== projectId) chooseProject(nextProjectId);
		};
		window.addEventListener("aware-selection", syncSelection);
		return () => window.removeEventListener("aware-selection", syncSelection);
	}, [projectId]);
	function chooseProject(id: string) {
		setSelectedProjectId(id, "tasks");
		setProjectIdState(id);
		setSelectedTaskIdState("");
		setTitle("");
		setBody("");
		setTaskWorktreeId("");
		setPageState("tasks", { selectedTaskId: "", title: "", body: "", worktreeId: "" });
	}
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
	const runsByTaskId = useMemo(() => {
		const groups = new Map<string, AgentRun[]>();
		for (const run of runs) {
			const group = groups.get(run.taskId) ?? [];
			group.push(run);
			groups.set(run.taskId, group);
		}
		for (const group of groups.values())
			group.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
		return groups;
	}, [runs]);
	const selectedTask = tasks.find((task) => task.id === selectedTaskId);
	const selectedTaskRuns = selectedTask ? (runsByTaskId.get(selectedTask.id) ?? []) : [];
	useEffect(() => {
		if (!selectedTask) return;
		setTitle(selectedTask.title);
		setBody(selectedTask.body);
		setTaskWorktreeId(selectedTask.worktreeId ?? "");
		setPageState("tasks", {
			selectedTaskId: selectedTask.id,
			title: selectedTask.title,
			body: selectedTask.body,
			worktreeId: selectedTask.worktreeId ?? "",
		});
	}, [selectedTask]);
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
		if (id) setSelectedWorktreeId(id, "tasks");
		setPageState("tasks", { worktreeId: id });
	}
	async function save() {
		if (!projectId || !title.trim() || savingTask) return;
		setSavingTask(true);
		try {
		const patch = { title, body, worktreeId: taskWorktreeId || null };
		if (selectedTaskId) {
			await apiPatch<Task>(`/tasks/${selectedTaskId}`, patch);
			setPageState("tasks", { title, body, worktreeId: taskWorktreeId });
			load();
			return;
		}
		const task = await apiPost<Task>("/tasks", { projectId, ...patch });
		setSelectedTaskId(task.id);
		setSelectedTaskIdState(task.id);
		setPageState("tasks", { selectedTaskId: task.id, title, body, worktreeId: taskWorktreeId });
		load();
		} finally {
			setSavingTask(false);
		}
	}
	async function start(id: string) {
		setStartingTaskId(id);
		const task = tasks.find((t) => t.id === id);
		setTasks((current) =>
			current.map((task) =>
				task.id === id
					? { ...task, status: "running", updatedAt: new Date().toISOString() }
					: task,
			),
		);
		try {
			const run = await apiPost<AgentRun>(`/tasks/${id}/start`, {
				worktreeId: task?.worktreeId,
			});
			setSelectedRunId(run.id);
			setSelectedWorktreeId(run.worktreeId, "tasks");
			window.dispatchEvent(new Event("aware:worktrees"));
			load();
			alert(`run ${run.id}`);
		} catch (error) {
			load();
			throw error;
		} finally {
			setStartingTaskId("");
		}
	}
	async function softUpdate(id: string, patch: Partial<Task>) {
		await apiPatch<Task>(`/tasks/${id}`, patch);
		newTask();
		load();
	}
	const hasSelection = Boolean(projectId);
	return (
		<section id="tasks" className="tasks-shell full-workspace">
			<div className="card tasks-page">
				<div className="tasks-header">
				<div>
					<h2>Tasks</h2>
					<p>
						Project tasks. Attach worktree in task details; default is new
						worktree.
					</p>
				</div>
				{loadingTasks ? <BusyIndicator label="Loading tasks" /> : null}
			</div>
			{!hasSelection ? (
				<p className="tasks-empty">No project selected.</p>
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
									{statusLabel(selectedTask.status)}
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
							{selectedTask ? (
								<button type="button" onClick={newTask}>
									New
								</button>
							) : null}
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
							: "Worktree agent will create a host worktree; agents see it as /workspace/<category>/<slug>."}
					</p>
					{selectedTask ? (
						<div className="task-runs-block">
							<strong>Related runs ({selectedTaskRuns.length})</strong>
							{selectedTaskRuns.length ? (
								<div className="task-run-links">
									{selectedTaskRuns.map((run) => (
										<RunLink key={run.id} runId={run.id} projectId={selectedTask.projectId}>
											{`${run.id.slice(0, 8)} · ${run.status}`}
										</RunLink>
									))}
								</div>
							) : (
								<small>No runs yet.</small>
							)}
						</div>
					) : null}
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
						<button type="submit" disabled={!hasSelection || !title.trim() || savingTask}>
							{savingTask ? "Saving…" : selectedTaskId ? "Save changes" : "Create task"}
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
						{loadingTasks ? <BusyIndicator label="Loading tasks" /> : null}
						{!loadingTasks && visibleTasks.length === 0 ? (
							<p className="tasks-empty">No tasks match current filters.</p>
						) : null}
						{visibleTasks.map((t) => {
							const isStarting = startingTaskId === t.id;
							const canStart = t.status !== "done" && t.status !== "running";
							const taskRuns = runsByTaskId.get(t.id) ?? [];
							const latestRun = taskRuns[0];
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
											{taskRuns.length ? ` · ${taskRuns.length} run${taskRuns.length === 1 ? "" : "s"}` : " · no runs"}
										</small>
										{latestRun ? (
											<div className="task-run-links compact">
												<RunLink runId={latestRun.id} projectId={t.projectId}>
													{`latest ${latestRun.id.slice(0, 8)} · ${latestRun.status}`}
												</RunLink>
												{taskRuns.slice(1, 4).map((run) => (
													<RunLink key={run.id} runId={run.id} projectId={t.projectId}>
														{run.id.slice(0, 8)}
													</RunLink>
												))}
											</div>
										) : null}
									</div>
									<div className="task-row-actions">
										<span className={`task-status status-${t.status}`}>
											{statusLabel(t.status)}
										</span>
										{canStart ? (
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													void start(t.id);
												}}
												disabled={isStarting}
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
			</div>
		</section>
	);
}
