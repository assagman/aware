import { randomUUID } from "node:crypto";
import type {
	AgentRun,
	RunStatus,
	Task,
	TaskAgent,
	TaskStatus,
} from "@agent-ide/shared";
import { db } from "../db/client";

const now = () => new Date().toISOString();

function taskStatusFromRun(status: RunStatus): TaskStatus {
	return status === "cancelled" ? "failed" : status;
}

export async function listTasks(
	filter: Partial<Pick<Task, "projectId" | "worktreeId">> = {},
) {
	const tasks = (await db.list<Task>("tasks")).filter(
		(task) =>
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
			status: latestRun ? taskStatusFromRun(latestRun.status) : task.status,
		};
	});
}

export async function createTask(
	input: Pick<Task, "projectId" | "worktreeId" | "title" | "body">,
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

export async function assignAgent(
	taskId: string,
	agentProfileId: string,
	role = "worker",
) {
	const row: TaskAgent = {
		id: randomUUID(),
		taskId,
		agentProfileId,
		role,
		orderIndex: (await listTaskAgents(taskId)).length,
	};
	return db.insert("taskAgents", row);
}

export async function listTaskAgents(taskId: string) {
	return (await db.list<TaskAgent>("taskAgents")).filter(
		(a) => a.taskId === taskId,
	);
}
