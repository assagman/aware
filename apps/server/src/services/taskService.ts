import { randomUUID } from "node:crypto";
import type { Task, TaskAgent } from "@agent-ide/shared";
import { db } from "../db/client";

const now = () => new Date().toISOString();

export async function listTasks() {
	return db.list<Task>("tasks");
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
