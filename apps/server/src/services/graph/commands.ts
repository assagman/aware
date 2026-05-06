import { lstat } from "node:fs/promises";
import type { AgentRun, AnnotationTaskSuggestion, RunLane, RunRelation, Task, Worktree } from "@aware/shared";
import { db } from "../../db/client";
import { flueRuntime } from "../agentRuntime/flueRuntime";
import { isDefaultBranch } from "../defaultBranchGuard";
import { git } from "../gitService";
import { assertAllowedWorktree, addProject, listStoredWorktrees } from "../projectService";
import { listMainAgentsForRun, listShippingAgentsForRun } from "../shippingAgentService";
import { worktreeAgent } from "../worktreeAgentService";
import { archiveTask, createTask, updateTask } from "../taskService";
import {
	getProjectOrThrow,
	getRunInTaskOrThrow,
	getTaskInProjectOrThrow,
	getWorktreeInProjectOrThrow,
	RouteValidationError,
} from "./validation";

export const AUTO_CONTINUE_MESSAGE =
	"Continue from the previous run state. If the prior run stopped unexpectedly, inspect the current worktree state and proceed with the original task without restarting from scratch.";

const SHIPPING_RUN_MESSAGE = [
	"Perform final shipping workflow for this task worktree now.",
	"Commit remaining changes atomically with `git commit -Ss -m \"type(scope): concise subject\"`.",
	"Rebase onto default branch, push origin, create concise PR with host CLI, merge it, cleanup branch/worktree, then sync default worktree.",
].join("\n");

function runLane(run: AgentRun): RunLane {
	return ["gate", "ship", "graph", "annotation", "annotation-tasks"].includes(run.lane ?? "") ? run.lane! : "task";
}

function activeRuns(runs: AgentRun[]) {
	return runs.filter((run) => !run.deletedAt);
}

async function branchExists(projectPath: string, branch: string) {
	try {
		await git(projectPath, ["show-ref", "--verify", `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

async function pathExists(path: string) {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

async function cleanupTaskWorktree(projectPath: string, worktree: Worktree | undefined) {
	if (!worktree || isDefaultBranch(worktree))
		return { worktreeRemoved: false, branchDeleted: false, skipped: true };
	const worktreeExists = await pathExists(worktree.path);
	if (worktreeExists) await git(projectPath, ["worktree", "remove", "--force", worktree.path]);
	const canDeleteBranch = worktree.branch && !isDefaultBranch(worktree) && await branchExists(projectPath, worktree.branch);
	if (canDeleteBranch) await git(projectPath, ["branch", "-D", worktree.branch]);
	const deletedAt = new Date().toISOString();
	await db.update<Worktree>("worktrees", worktree.id, { deletedAt, updatedAt: deletedAt });
	return {
		worktreeRemoved: worktreeExists,
		branchDeleted: Boolean(canDeleteBranch),
		skipped: false,
	};
}

export async function createProjectCommand(input: { path: string }) {
	return addProject(input.path);
}

export async function createTaskCommand(input: {
	projectId: string;
	title: string;
	body?: string | undefined;
	worktreeId?: string | undefined;
	annotationTaskSuggestionId?: string | undefined;
	sourceAnnotationIds?: string[] | undefined;
}) {
	await getProjectOrThrow(input.projectId);
	if (input.worktreeId)
		await getWorktreeInProjectOrThrow(input.projectId, input.worktreeId);
	const task = await createTask({
		projectId: input.projectId,
		title: input.title,
		body: input.body ?? "",
		...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
		...(input.annotationTaskSuggestionId ? { annotationTaskSuggestionId: input.annotationTaskSuggestionId } : {}),
		...(input.sourceAnnotationIds?.length ? { sourceAnnotationIds: input.sourceAnnotationIds } : {}),
	});
	if (input.annotationTaskSuggestionId)
		await db.update<AnnotationTaskSuggestion>("annotationTaskSuggestions", input.annotationTaskSuggestionId, {
			status: "created",
			taskId: task.id,
			updatedAt: new Date().toISOString(),
		});
	return task;
}

export async function updateTaskCommand(input: {
	projectId: string;
	taskId: string;
	title?: string | undefined;
	body?: string | undefined;
	worktreeId?: string | null | undefined;
	archivedAt?: string | null | undefined;
	deletedAt?: string | null | undefined;
}) {
	const task = await getTaskInProjectOrThrow(input.projectId, input.taskId);
	if (input.worktreeId)
		await getWorktreeInProjectOrThrow(input.projectId, input.worktreeId);
	const patch: Record<string, unknown> = {};
	if (input.title !== undefined) patch.title = input.title;
	if (input.body !== undefined) patch.body = input.body;
	if ("worktreeId" in input) patch.worktreeId = input.worktreeId || undefined;
	if (input.archivedAt !== undefined && input.archivedAt !== null)
		patch.archivedAt = input.archivedAt;
	if (input.deletedAt !== undefined && input.deletedAt !== null)
		patch.deletedAt = input.deletedAt;
	return updateTask(task.id, patch as Partial<Task>);
}

export async function archiveTaskCommand(input: {
	projectId: string;
	taskId: string;
	cleanup?: boolean | undefined;
	status?: Task["status"] | undefined;
}) {
	const task = await getTaskInProjectOrThrow(input.projectId, input.taskId);
	const project = await getProjectOrThrow(input.projectId);
	const worktree = task.worktreeId
		? (await listStoredWorktrees()).find((row) => row.id === task.worktreeId && row.projectId === project.id)
		: undefined;
	const cleanup = input.cleanup ? await cleanupTaskWorktree(project.rootPath, worktree) : undefined;
	const archived = await archiveTask(task.id, input.status ? { status: input.status } : {});
	return { task: archived, cleanup };
}

async function assertParentRun(input: {
	taskId: string;
	parentRunId?: string | undefined;
	relation: RunRelation;
}) {
	if (!input.parentRunId) return undefined;
	const activeRuns = (await db.list<AgentRun>("runs")).filter(
		(run) => run.taskId === input.taskId && !run.deletedAt,
	);
	const parentRun = activeRuns.find((run) => run.id === input.parentRunId);
	if (!parentRun) throw new RouteValidationError("missing parent run", 400);
	if (
		input.relation === "sequential" &&
		activeRuns.some(
			(run) =>
				run.parentRunId === input.parentRunId &&
				run.relation === "sequential",
		)
	)
		throw new RouteValidationError(
			"sequential run already exists for parent",
			409,
		);
	return parentRun;
}

export async function startRunCommand(input: {
	projectId: string;
	taskId: string;
	message?: string | undefined;
	worktreeId?: string | undefined;
	relation?: RunRelation | undefined;
	lane?: RunLane | undefined;
	parentRunId?: string | undefined;
}) {
	const task = await getTaskInProjectOrThrow(input.projectId, input.taskId);
	const project = await getProjectOrThrow(task.projectId);
	const requestedWorktreeId = input.worktreeId || task.worktreeId;
	const requestedWorktree = requestedWorktreeId
		? await assertAllowedWorktree(requestedWorktreeId)
		: undefined;
	if (requestedWorktree && requestedWorktree.projectId !== task.projectId)
		throw new RouteValidationError(
			"worktree does not belong to task project",
			400,
		);
	const relation = input.relation === "sequential" ? "sequential" : "parallel";
	const parentRun = await assertParentRun({
		taskId: task.id,
		relation,
		...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
	});
	const lane = input.lane === "gate" ? "gate" : parentRun?.lane === "gate" ? "gate" : "task";
	const worktree = await worktreeAgent.ensureTaskWorktree(
		project,
		requestedWorktree ? { ...task, worktreeId: requestedWorktree.id } : task,
	);
	const taskWorktreeInfo =
		requestedWorktree && requestedWorktree.id === worktree.id
			? `Task worktree: ${worktree.path} (${worktree.branch || "unknown branch"}).`
			: `Task worktree: Worktree agent created ${worktree.path} (${worktree.branch}).`;
	const message = input.message?.trim() || task.body;
	const runTask: Task = {
		...task,
		worktreeId: worktree.id,
		status: "running",
		body: `${taskWorktreeInfo}\n\nTask brief:\n${task.body}`,
	};
	await updateTask(task.id, { status: "running", worktreeId: worktree.id });
	const agents = await listMainAgentsForRun();
	return flueRuntime.startRun({
		task: runTask,
		worktreeId: worktree.id,
		worktreePath: worktree.path,
		agents,
		message,
		relation,
		lane,
		...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
	});
}

export async function sendRunMessageCommand(input: {
	projectId: string;
	taskId: string;
	runId: string;
	message: string;
}) {
	await getRunInTaskOrThrow(input.projectId, input.taskId, input.runId);
	void flueRuntime.continueRun(input.runId, input.message);
	return { ok: true };
}

export async function retryRunCommand(input: {
	projectId: string;
	taskId: string;
	runId: string;
	message?: string | undefined;
}) {
	const source = await getRunInTaskOrThrow(input.projectId, input.taskId, input.runId);
	if (runLane(source) === "ship") return startShippingRunCommand(input);
	return startRunCommand({
		projectId: input.projectId,
		taskId: input.taskId,
		...(input.message ?? source.request ? { message: input.message ?? source.request } : {}),
		relation: source.relation ?? "parallel",
		...(source.lane ? { lane: source.lane } : {}),
		...(source.parentRunId ? { parentRunId: source.parentRunId } : {}),
	});
}

export async function deleteRunCommand(input: {
	projectId: string;
	taskId: string;
	runId: string;
}) {
	await getRunInTaskOrThrow(input.projectId, input.taskId, input.runId);
	return db.update<AgentRun>("runs", input.runId, {
		deletedAt: new Date().toISOString(),
	});
}

export async function markTaskDoneCommand(input: {
	projectId: string;
	taskId: string;
}) {
	const task = await getTaskInProjectOrThrow(input.projectId, input.taskId);
	if (task.status === "done") return task;
	const taskLaneRuns = (await db.list<AgentRun>("runs")).filter(
		(run) => run.taskId === task.id && !run.deletedAt && runLane(run) === "task",
	);
	if (!taskLaneRuns.length || taskLaneRuns.some((run) => run.status !== "done"))
		throw new RouteValidationError("all task-lane runs must be marked done first", 409);
	return updateTask(task.id, { status: "done" });
}

export const createCheckpointCommand = markTaskDoneCommand;

export async function startShippingRunCommand(input: {
	projectId: string;
	taskId: string;
}) {
	const task = await getTaskInProjectOrThrow(input.projectId, input.taskId);
	const project = await getProjectOrThrow(task.projectId);
	if (!task.worktreeId)
		throw new RouteValidationError("task has no worktree to ship", 409);
	const worktree = await getWorktreeInProjectOrThrow(project.id, task.worktreeId);
	const runs = activeRuns(
		(await db.list<AgentRun>("runs")).filter((run) => run.taskId === task.id),
	);
	const taskLaneRuns = runs.filter((run) => runLane(run) === "task");
	const gateRuns = runs.filter((run) => runLane(run) === "gate");
	const shipRuns = runs.filter((run) => runLane(run) === "ship");
	if (!taskLaneRuns.length || taskLaneRuns.some((run) => run.status !== "done"))
		throw new RouteValidationError("all task-lane runs must be done before shipping", 409);
	if (gateRuns.some((run) => run.status !== "done"))
		throw new RouteValidationError("all gate-lane runs must be done before shipping", 409);
	if (shipRuns.some((run) => run.status === "running" || run.status === "queued"))
		throw new RouteValidationError("shipping run already active", 409);
	if (shipRuns.some((run) => run.status === "need_review" || run.status === "done"))
		throw new RouteValidationError("shipping run already exists", 409);
	const agents = await listShippingAgentsForRun();
	const runTask: Task = {
		...task,
		worktreeId: worktree.id,
		status: "running",
		body: [
			"Shipping context:",
			`Project: ${project.name}`,
			`Project root/default worktree candidate: ${project.rootPath}`,
			`Task worktree: ${worktree.path}`,
			`Task branch: ${worktree.branch || "unknown"}`,
			"",
			"Task brief:",
			task.body || "(none)",
		].join("\n"),
	};
	return flueRuntime.startRun({
		task: runTask,
		worktreeId: worktree.id,
		worktreePath: worktree.path,
		agents,
		message: SHIPPING_RUN_MESSAGE,
		relation: "sequential",
		lane: "ship",
	});
}
