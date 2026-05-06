import { randomUUID } from "node:crypto";
import type { AgentRun, Task, TaskStatus } from "@aware/shared";
import { db } from "../db/client";

const now = () => new Date().toISOString();

function activeRuns(runs: AgentRun[]) {
	return runs.filter((run) => !run.deletedAt);
}

function taskStatusFromRuns(task: Task, runs: AgentRun[]): TaskStatus {
	const active = activeRuns(runs);
	if (!active.length) return task.status === "done" ? "done" : "draft";
	if (task.status === "done" && active.every((run) => run.status === "done"))
		return "done";
	if (active.some((run) => run.status === "running" || run.status === "queued"))
		return "running";
	if (active.some((run) => run.status === "need_review")) return "need_review";
	if (active.length && active.every((run) => run.status === "done")) return "need_review";
	if (active.some((run) => run.status === "failed" || run.status === "cancelled"))
		return "failed";
	return task.status;
}

export async function listTasks(
	filter: Partial<Pick<Task, "projectId" | "worktreeId">> = {},
	options: { includeArchived?: boolean; archivedOnly?: boolean } = {},
) {
	const tasks = (await db.list<Task>("tasks")).filter(
		(task) =>
			!task.deletedAt &&
			(options.includeArchived || !task.archivedAt) &&
			(!options.archivedOnly || Boolean(task.archivedAt)) &&
			(!filter.projectId || task.projectId === filter.projectId) &&
			(!filter.worktreeId || task.worktreeId === filter.worktreeId),
	);
	const runs = await db.list<AgentRun>("runs");
	return tasks.map((task) => {
		const taskRuns = runs.filter((run) => run.taskId === task.id);
		return {
			...task,
			title: task.title === "Direct chat" ? "task" : task.title,
			status: !task.archivedAt && taskRuns.length ? taskStatusFromRuns(task, taskRuns) : task.status,
		};
	});
}

export async function createTask(
	input: Pick<Task, "projectId" | "title" | "body"> & { worktreeId?: string },
) {
	const row: Task = {
		...input,
		id: randomUUID(),
		status: "draft",
		createdAt: now(),
		updatedAt: now(),
	};
	return db.insert("tasks", row);
}

export async function updateTask(id: string, patch: Partial<Task>) {
	return db.update<Task>("tasks", id, { ...patch, updatedAt: now() });
}

export async function archiveTask(id: string, patch: Partial<Pick<Task, "status">> = {}) {
	return updateTask(id, { ...patch, archivedAt: now() });
}

export async function archiveTasksForWorktree(worktreeId: string, archivedAt = now()) {
	const tasks = await db.list<Task>("tasks");
	await Promise.all(
		tasks
			.filter((task) => task.worktreeId === worktreeId && !task.archivedAt && !task.deletedAt)
			.map((task) => updateTask(task.id, { archivedAt })),
	);
}

export async function allTaskRunsDone(taskId: string) {
	const runs = activeRuns(
		(await db.list<AgentRun>("runs")).filter((run) => run.taskId === taskId),
	);
	return runs.length > 0 && runs.every((run) => run.status === "done");
}

