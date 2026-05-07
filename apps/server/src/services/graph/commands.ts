import { graphStartExecutionPlanInputSchema } from "@aware/shared";
import type { AgentRun, AnnotationTaskSuggestion, RunLane, RunRelation, Task } from "@aware/shared";
import type { z } from "zod";
import { db } from "../../db/client";
import { flueRuntime } from "../agentRuntime/flueRuntime";
import { assertAllowedWorktree, addProject } from "../projectService";
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
	"Rebase onto default branch, push origin, create concise PR with host CLI, and merge it.",
	"Do not cleanup branches/worktrees or sync/pull default worktrees.",
].join("\n");

function runLane(run: AgentRun): RunLane {
	return ["gate", "ship", "graph", "annotation", "annotation-tasks"].includes(run.lane ?? "") ? run.lane! : "task";
}

function activeRuns(runs: AgentRun[]) {
	return runs.filter((run) => !run.deletedAt);
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
	status?: Task["status"] | undefined;
}) {
	const task = await getTaskInProjectOrThrow(input.projectId, input.taskId);
	return archiveTask(task.id, input.status ? { status: input.status } : {});
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
	if (relation === "sequential" && !input.parentRunId)
		throw new RouteValidationError("sequential run requires parentRunId", 400);
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

type ExecutionPlan = z.infer<typeof graphStartExecutionPlanInputSchema>;
type ExecutionPlanRun = ExecutionPlan["runs"][number];

function normalizedText(value: string | undefined) {
	return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function activeOrCompletedRun(run: AgentRun) {
	return !run.deletedAt && ["queued", "running", "need_review", "done"].includes(run.status);
}

function validateExecutionPlan(plan: ExecutionPlan) {
	const seen = new Set<string>();
	const prompts = new Set<string>();
	for (const run of plan.runs) {
		if (seen.has(run.planId))
			throw new RouteValidationError(`duplicate planId: ${run.planId}`, 400);
		seen.add(run.planId);
		const promptKey = normalizedText(run.prompt);
		if (prompts.has(promptKey))
			throw new RouteValidationError(`duplicate run prompt in plan: ${run.planId}`, 400);
		prompts.add(promptKey);
		if (run.relation === "sequential" && !run.parentPlanId)
			throw new RouteValidationError(`sequential plan run ${run.planId} requires parentPlanId`, 400);
		if (run.relation === "parallel" && run.parentPlanId)
			throw new RouteValidationError(`parallel plan run ${run.planId} must not set parentPlanId`, 400);
	}
	for (const run of plan.runs) {
		if (!run.parentPlanId) continue;
		if (run.parentPlanId === run.planId)
			throw new RouteValidationError(`plan run ${run.planId} cannot depend on itself`, 400);
		if (!seen.has(run.parentPlanId))
			throw new RouteValidationError(`missing parentPlanId for ${run.planId}: ${run.parentPlanId}`, 400);
	}
	const sequentialParentPlanIds = new Set<string>();
	for (const run of plan.runs) {
		if (run.relation !== "sequential" || !run.parentPlanId) continue;
		if (sequentialParentPlanIds.has(run.parentPlanId))
			throw new RouteValidationError(`multiple sequential children for parentPlanId: ${run.parentPlanId}`, 400);
		sequentialParentPlanIds.add(run.parentPlanId);
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const byPlanId = new Map(plan.runs.map((run) => [run.planId, run]));
	const visit = (run: ExecutionPlanRun) => {
		if (visited.has(run.planId)) return;
		if (visiting.has(run.planId))
			throw new RouteValidationError(`cycle in execution plan at ${run.planId}`, 400);
		visiting.add(run.planId);
		const parent = run.parentPlanId ? byPlanId.get(run.parentPlanId) : undefined;
		if (parent) visit(parent);
		visiting.delete(run.planId);
		visited.add(run.planId);
	};
	for (const run of plan.runs) visit(run);
}

function orderedExecutionPlanRuns(plan: ExecutionPlan) {
	const byPlanId = new Map(plan.runs.map((run) => [run.planId, run]));
	const ordered: ExecutionPlanRun[] = [];
	const visited = new Set<string>();
	const visit = (run: ExecutionPlanRun) => {
		if (visited.has(run.planId)) return;
		const parent = run.parentPlanId ? byPlanId.get(run.parentPlanId) : undefined;
		if (parent) visit(parent);
		visited.add(run.planId);
		ordered.push(run);
	};
	for (const run of plan.runs) visit(run);
	return ordered;
}

function equivalentRunForPlanRun(runs: AgentRun[], taskId: string, planRun: ExecutionPlanRun) {
	const promptKey = normalizedText(planRun.prompt);
	return runs.find(
		(run) =>
			run.taskId === taskId &&
			activeOrCompletedRun(run) &&
			runLane(run) === "task" &&
			normalizedText(run.request) === promptKey,
	);
}

function sequentialChildConflictForPlanRun(runs: AgentRun[], taskId: string, parentRunId: string, planRun: ExecutionPlanRun) {
	const equivalent = equivalentRunForPlanRun(runs, taskId, planRun);
	return runs.find(
		(run) =>
			run.taskId === taskId &&
			activeOrCompletedRun(run) &&
			run.relation === "sequential" &&
			run.parentRunId === parentRunId &&
			run.id !== equivalent?.id,
	);
}

export async function startExecutionPlanCommand(rawInput: unknown) {
	const parsed = graphStartExecutionPlanInputSchema.safeParse(rawInput);
	if (!parsed.success)
		throw new RouteValidationError(parsed.error.issues[0]?.message ?? "invalid execution plan", 400);
	const plan = parsed.data;
	await getTaskInProjectOrThrow(plan.projectId, plan.taskId);
	validateExecutionPlan(plan);
	const existingRuns = await db.list<AgentRun>("runs");
	const equivalentRunsByPlanId = new Map(
		plan.runs
			.map((planRun) => [planRun.planId, equivalentRunForPlanRun(existingRuns, plan.taskId, planRun)] as const)
			.filter((entry): entry is readonly [string, AgentRun] => Boolean(entry[1])),
	);
	for (const planRun of plan.runs) {
		const parentRunId = planRun.parentPlanId ? equivalentRunsByPlanId.get(planRun.parentPlanId)?.id : undefined;
		if (!parentRunId) continue;
		const conflict = sequentialChildConflictForPlanRun(existingRuns, plan.taskId, parentRunId, planRun);
		if (conflict)
			throw new RouteValidationError(`sequential child already exists for parent plan ${planRun.parentPlanId}`, 409);
	}
	const created: Array<{ planId: string; run: AgentRun }> = [];
	const existing: Array<{ planId: string; run: AgentRun }> = [];
	const runIdsByPlanId = new Map<string, string>();
	for (const planRun of orderedExecutionPlanRuns(plan)) {
		const equivalent = equivalentRunForPlanRun(existingRuns, plan.taskId, planRun);
		if (equivalent) {
			runIdsByPlanId.set(planRun.planId, equivalent.id);
			existing.push({ planId: planRun.planId, run: equivalent });
			continue;
		}
		const parentRunId = planRun.parentPlanId ? runIdsByPlanId.get(planRun.parentPlanId) : undefined;
		if (planRun.relation === "sequential" && !parentRunId)
			throw new RouteValidationError(`missing parent run for ${planRun.planId}`, 400);
		const run = await startRunCommand({
			projectId: plan.projectId,
			taskId: plan.taskId,
			message: planRun.prompt,
			relation: planRun.relation,
			lane: "task",
			...(parentRunId ? { parentRunId } : {}),
		});
		runIdsByPlanId.set(planRun.planId, run.id);
		created.push({ planId: planRun.planId, run });
		existingRuns.push(run);
	}
	return {
		ok: true,
		created,
		existing,
	};
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
			`Project root: ${project.rootPath}`,
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
