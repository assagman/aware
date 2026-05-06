import type { AgentRun, Project, Task, Worktree } from "@aware/shared";
import { db } from "../../db/client";
import { listProjects, listWorktrees } from "../projectService";
import { listTasks } from "../taskService";

export class RouteValidationError extends Error {
	status: 400 | 404 | 409;
	constructor(message: string, status: 400 | 404 | 409 = 404) {
		super(message);
		this.status = status;
	}
}

export async function getProjectOrThrow(projectId: string): Promise<Project> {
	const project = (await listProjects()).find((row) => row.id === projectId);
	if (!project) throw new RouteValidationError("missing project", 404);
	return project;
}

export async function getTaskInProjectOrThrow(
	projectId: string,
	taskId: string,
): Promise<Task> {
	await getProjectOrThrow(projectId);
	const task = (await listTasks()).find((row) => row.id === taskId);
	if (!task) throw new RouteValidationError("missing task", 404);
	if (task.projectId !== projectId)
		throw new RouteValidationError("task does not belong to project", 404);
	return task;
}

export async function getRunInTaskOrThrow(
	projectId: string,
	taskId: string,
	runId: string,
): Promise<AgentRun> {
	await getTaskInProjectOrThrow(projectId, taskId);
	const run = (await db.list<AgentRun>("runs")).find((row) => row.id === runId);
	if (!run) throw new RouteValidationError("missing run", 404);
	if (run.taskId !== taskId)
		throw new RouteValidationError("run does not belong to task", 404);
	return run;
}

export async function getWorktreeInProjectOrThrow(
	projectId: string,
	worktreeId: string,
): Promise<Worktree> {
	await getProjectOrThrow(projectId);
	const worktree = (await listWorktrees()).find((row) => row.id === worktreeId);
	if (!worktree) throw new RouteValidationError("missing worktree", 404);
	if (worktree.projectId !== projectId)
		throw new RouteValidationError("worktree does not belong to project", 404);
	return worktree;
}
