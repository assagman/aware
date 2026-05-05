import { randomUUID } from "node:crypto";
import type {
	AgentRun,
	RunStatus,
	Task,
	TaskStatus,
} from "@aware/shared";
import { db } from "../db/client";

const now = () => new Date().toISOString();

function taskStatusFromRun(task: Task, status: RunStatus): TaskStatus {
	if (status === "cancelled") return "failed";
	if (status === "done") return task.status === "done" ? "done" : "need_review";
	return status;
}

export async function listTasks(
	filter: Partial<Pick<Task, "projectId" | "worktreeId">> = {},
) {
	const tasks = (await db.list<Task>("tasks")).filter(
		(task) =>
			!task.archivedAt &&
			!task.deletedAt &&
			(!filter.projectId || task.projectId === filter.projectId) &&
			(!filter.worktreeId || task.worktreeId === filter.worktreeId),
	);
	const runs = await db.list<AgentRun>("runs");
	return tasks.map((task) => {
		const latestRun = runs
			.filter((run) => run.taskId === task.id)
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
		return {
			...task,
			title: task.title === "Direct chat" ? "task" : task.title,
			status: latestRun ? taskStatusFromRun(task, latestRun.status) : task.status,
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

