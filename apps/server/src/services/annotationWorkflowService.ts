import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentRun, Annotation, AnnotationTaskSuggestion, Project, Task, Worktree } from "@aware/shared";
import { db } from "../db/client";
import { flueRuntime } from "./agentRuntime/flueRuntime";
import { git, worktreeRoot } from "./gitService";
import { getProjectOrThrow, getTaskInProjectOrThrow, getWorktreeInProjectOrThrow, RouteValidationError } from "./graph/validation";
import { addWorktree, listWorktrees } from "./projectService";
import { listGraphAgentsForRun } from "./graphAgentService";
import { listMainAgentsForRun } from "./shippingAgentService";
import { createTask, listTasks } from "./taskService";
import { startRunCommand } from "./graph/commands";
import { worktreePathForBranch } from "./workspaceConvention";
import { withQueuedLock } from "./worktreeLock";
import {
	annotationLocation,
	getAnnotationInProject,
	getAnnotationTaskSuggestion,
	listAnnotations,
	markAnnotationsProcessing,
	markAnnotationTaskSuggestions,
	saveAnnotationTaskSuggestions,
	serializeAnnotations,
	updateAnnotation,
} from "./annotationService";

const now = () => new Date().toISOString();

function yyyymmdd(date = new Date()) {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}${m}${d}`;
}

async function branchExists(project: Project, branch: string) {
	try {
		await git(project.rootPath, ["show-ref", "--verify", `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

async function annotationBranch(project: Project) {
	const { stdout } = await git(project.rootPath, ["rev-parse", "--short=8", "HEAD"]);
	return `anno-${stdout.trim()}-${yyyymmdd()}`;
}

export async function ensureAnnotationWorktree(project: Project) {
	return withQueuedLock(`annotation-worktree:${project.id}`, async () => {
		const branch = await annotationBranch(project);
		const existing = (await listWorktrees()).find((worktree) => worktree.projectId === project.id && worktree.branch === branch && !worktree.deletedAt);
		if (existing) return existing;
		const root = await worktreeRoot(project.rootPath);
		const path = worktreePathForBranch(branch, root);
		await mkdir(dirname(path), { recursive: true });
		if (await branchExists(project, branch)) await git(project.rootPath, ["worktree", "add", path, branch]);
		else await git(project.rootPath, ["worktree", "add", "-b", branch, path]);
		return addWorktree(project.id, path);
	});
}

function annotationRunMessage(annotations: Annotation[], userPrompt?: string | undefined) {
	return [
		"## User request",
		"",
		userPrompt?.trim() || "Handle these Aware annotations in isolation.",
		"",
		"## Instructions",
		"",
		"Use annotation context exactly; preserve file paths, line ranges, exact selections, and notes when editing.",
		"If multiple annotations conflict, report tradeoffs before broad changes.",
		"",
		"## Annotations",
		"",
		serializeAnnotations(annotations),
	].join("\n");
}

export async function startAnnotationRun(input: {
	projectId: string;
	annotationIds: string[];
	message?: string | undefined;
}) {
	const project = await getProjectOrThrow(input.projectId);
	const annotations = (await Promise.all(input.annotationIds.map((id) => getAnnotationInProject(project.id, id))))
		.filter((item): item is Annotation => Boolean(item));
	if (!annotations.length) throw new RouteValidationError("missing annotations", 404);
	const worktree = await ensureAnnotationWorktree(project);
	const agents = await listMainAgentsForRun();
	const message = annotationRunMessage(annotations, input.message);
	const run = await flueRuntime.startChat({
		projectId: project.id,
		worktreeId: worktree.id,
		worktreePath: worktree.path,
		agents,
		message,
		annotations,
		annotationIds: annotations.map((annotation) => annotation.id),
		taskTitle: annotations.length === 1 ? `Annotation: ${annotationLocation(annotations[0]!)}` : `Annotations: ${annotations.length}`,
		taskSource: "annotation-run",
	});
	await markAnnotationsProcessing(annotations.map((annotation) => annotation.id), run.id);
	return run;
}

function projectWorktree(project: Project, worktrees: Worktree[]) {
	const scoped = worktrees.filter((worktree) => worktree.projectId === project.id && !worktree.deletedAt);
	return scoped.find((worktree) => worktree.branch === "main")
		?? scoped.find((worktree) => worktree.path === project.rootPath)
		?? scoped.find((worktree) => worktree.branch === "master")
		?? scoped[0];
}

function isDefaultWorktree(project: Project, worktree: Worktree | undefined) {
	if (!worktree) return false;
	return worktree.path === project.rootPath || worktree.branch === "main" || worktree.branch === "master";
}

function classifySuggestionTarget(project: Project, worktrees: Worktree[], annotations: Annotation[]) {
	if (!annotations.length) return "task" as const;
	return annotations.every((annotation) => isDefaultWorktree(project, worktrees.find((worktree) => worktree.id === annotation.worktreeId))) ? "task" : "run";
}

function primaryWorktreeId(suggestion: AnnotationTaskSuggestion, annotations: Annotation[]) {
	if (suggestion.worktreeId) return suggestion.worktreeId;
	const ids = [...new Set(annotations.map((annotation) => annotation.worktreeId).filter(Boolean))];
	return ids.length === 1 ? ids[0] : undefined;
}

async function createAnnotationTasksSystemTask(project: Project, title: string, body: string, worktree: Worktree) {
	return createTask({
		projectId: project.id,
		worktreeId: worktree.id,
		title,
		body,
		source: "annotation-tasks",
	});
}

export async function startAnnotationTaskGeneratorRun(projectId: string, input: { annotationIds?: string[]; worktreeId?: string } = {}) {
	const project = await getProjectOrThrow(projectId);
	const worktrees = await listWorktrees();
	const worktree = projectWorktree(project, worktrees);
	if (!worktree) throw new RouteValidationError("project has no worktree for annotation suggestions", 409);
	const annotations = (await listAnnotations({ projectId: project.id, state: "active", ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}) }))
		.filter((annotation) => !input.annotationIds?.length || input.annotationIds.includes(annotation.id));
	const task = await createAnnotationTasksSystemTask(
		project,
		"Annotation suggestions generator",
		serializeAnnotations(annotations) || "No active annotations yet.",
		worktree,
	);
	const agents = await listGraphAgentsForRun();
	const message = [
		"## Run context",
		"",
		"- **Mode:** annotation_suggestions",
		`- **Project id:** ${project.id}`,
		"",
		"## Instructions",
		"",
		"Generate suggestions for Annotations page only. Do not create tasks or runs directly.",
		"Call graph_save_annotation_task_suggestions with concise titles/bodies and relevant annotationIds.",
		"Set targetKind='task' only when every source annotation is on the default worktree (project root/main/master).",
		"Set targetKind='run' when any source annotation is on a custom worktree. Include worktreeId and taskId if known.",
		"Preserve invariant: 1 task : 1 worktree. Custom-worktree suggestions attach runs to existing task/worktree flow.",
		"Use graph_get_projection only for current tasks/runs/worktrees; annotations are provided below.",
		"",
		"## Active annotations",
		"",
		serializeAnnotations(annotations) || "(none)",
	].join("\n");
	return flueRuntime.startRun({
		task: { ...task, status: "running" },
		worktreeId: worktree.id,
		worktreePath: worktree.path,
		agents,
		message,
		relation: "parallel",
		lane: "annotation-tasks",
		affectsTaskStatus: false,
		completedStatus: "done",
	});
}

async function suggestionAnnotations(projectId: string, suggestion: AnnotationTaskSuggestion) {
	if (!suggestion.annotationIds?.length) return [];
	return (await Promise.all(suggestion.annotationIds.map((id) => getAnnotationInProject(projectId, id))))
		.filter((item): item is Annotation => Boolean(item));
}

async function upsertSuggestionForApproval(projectId: string, input: {
	id?: string | undefined;
	title: string;
	body?: string | undefined;
	targetKind?: "task" | "run" | undefined;
	annotationIds?: string[] | undefined;
	worktreeId?: string | undefined;
	taskId?: string | undefined;
}) {
	const title = input.title.trim();
	if (!title) throw new RouteValidationError("missing approved suggestion title", 400);
	if (input.id) {
		const existing = await getAnnotationTaskSuggestion(projectId, input.id);
		if (!existing) throw new RouteValidationError("missing suggestion", 404);
		const updated = await db.update<AnnotationTaskSuggestion>("annotationTaskSuggestions", input.id, {
			title,
			body: input.body ?? existing.body,
			status: "creating",
			...(input.targetKind ? { targetKind: input.targetKind } : {}),
			...(input.annotationIds?.length ? { annotationIds: input.annotationIds } : {}),
			...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
			...(input.taskId ? { taskId: input.taskId } : {}),
			updatedAt: now(),
		});
		if (!updated) throw new RouteValidationError("missing suggestion", 404);
		return updated;
	}
	const [created] = await saveAnnotationTaskSuggestions({
		projectId,
		suggestions: [{
			title,
			body: input.body ?? "",
			...(input.targetKind ? { targetKind: input.targetKind } : {}),
			...(input.annotationIds?.length ? { annotationIds: input.annotationIds } : {}),
			...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
			...(input.taskId ? { taskId: input.taskId } : {}),
		}],
	});
	if (!created) throw new RouteValidationError("missing suggestion", 400);
	await markAnnotationTaskSuggestions([created.id], { status: "creating" });
	return { ...created, status: "creating" as const };
}

async function taskForSuggestionRun(projectId: string, suggestion: AnnotationTaskSuggestion, worktreeId: string) {
	if (suggestion.taskId) return getTaskInProjectOrThrow(projectId, suggestion.taskId);
	const tasks = await listTasks({ projectId, worktreeId });
	const task = tasks.find((item) => !item.archivedAt && !item.deletedAt);
	if (!task) throw new RouteValidationError("custom-worktree suggestion needs existing task for worktree", 409);
	return task;
}

export async function approveAnnotationSuggestion(input: {
	projectId: string;
	suggestionId?: string | undefined;
	title?: string | undefined;
	body?: string | undefined;
	targetKind?: "task" | "run" | undefined;
	annotationIds?: string[] | undefined;
	worktreeId?: string | undefined;
	taskId?: string | undefined;
}) {
	const project = await getProjectOrThrow(input.projectId);
	const base = input.suggestionId
		? await getAnnotationTaskSuggestion(project.id, input.suggestionId)
		: undefined;
	if (input.suggestionId && !base) throw new RouteValidationError("missing suggestion", 404);
	const title = input.title ?? base?.title ?? "";
	const body = input.body ?? base?.body ?? "";
	const requestedTargetKind = input.targetKind ?? base?.targetKind;
	const candidateAnnotationIds = input.annotationIds ?? base?.annotationIds;
	const candidateWorktreeId = input.worktreeId ?? base?.worktreeId;
	const candidateTaskId = input.taskId ?? base?.taskId;
	const candidate: AnnotationTaskSuggestion = {
		id: base?.id ?? "approval-candidate",
		projectId: project.id,
		title: title.trim(),
		body,
		status: base?.status ?? "draft",
		...(requestedTargetKind ? { targetKind: requestedTargetKind } : {}),
		...(candidateAnnotationIds?.length ? { annotationIds: candidateAnnotationIds } : {}),
		...(candidateWorktreeId ? { worktreeId: candidateWorktreeId } : {}),
		...(candidateTaskId ? { taskId: candidateTaskId } : {}),
		createdAt: base?.createdAt ?? now(),
		updatedAt: base?.updatedAt ?? now(),
	};
	if (!candidate.title) throw new RouteValidationError("missing approved suggestion title", 400);
	const annotations = await suggestionAnnotations(project.id, candidate);
	const worktrees = await listWorktrees();
	const targetKind = candidate.targetKind ?? classifySuggestionTarget(project, worktrees, annotations);
	let runPlan: { worktreeId: string; task: Task } | undefined;
	if (targetKind === "run") {
		const worktreeId = primaryWorktreeId(candidate, annotations);
		if (!worktreeId) throw new RouteValidationError("run suggestion needs one worktree", 409);
		await getWorktreeInProjectOrThrow(project.id, worktreeId);
		runPlan = { worktreeId, task: await taskForSuggestionRun(project.id, candidate, worktreeId) };
	}
	const suggestion = await upsertSuggestionForApproval(project.id, {
		...(base ? { id: base.id } : {}),
		title,
		body,
		targetKind,
		...(candidate.annotationIds?.length ? { annotationIds: candidate.annotationIds } : {}),
		...(candidate.worktreeId ? { worktreeId: candidate.worktreeId } : {}),
		...(candidate.taskId ? { taskId: candidate.taskId } : {}),
	});
	if (targetKind === "task") {
		const task = await createTask({
			projectId: project.id,
			title: suggestion.title,
			body: suggestion.body,
			annotationTaskSuggestionId: suggestion.id,
			...(suggestion.annotationIds?.length ? { sourceAnnotationIds: suggestion.annotationIds } : {}),
		});
		await markAnnotationTaskSuggestions([suggestion.id], { status: "created", targetKind, taskId: task.id });
		return { suggestion: { ...suggestion, status: "created" as const, targetKind, taskId: task.id }, task };
	}
	const { worktreeId, task } = runPlan!;
	await Promise.all(annotations.map((annotation) => updateAnnotation(annotation.id, { taskId: task.id })));
	const message = annotationRunMessage(annotations, suggestion.body || suggestion.title);
	const run = await startRunCommand({
		projectId: project.id,
		taskId: task.id,
		worktreeId,
		message,
		relation: "parallel",
		lane: "task",
	});
	await markAnnotationsProcessing(annotations.map((annotation) => annotation.id), run.id);
	await markAnnotationTaskSuggestions([suggestion.id], { status: "created", targetKind, taskId: task.id, runId: run.id, worktreeId });
	return { suggestion: { ...suggestion, status: "created" as const, targetKind, taskId: task.id, runId: run.id, worktreeId }, run, task };
}

export async function rejectAnnotationSuggestion(projectId: string, suggestionId: string) {
	await getProjectOrThrow(projectId);
	const suggestion = await getAnnotationTaskSuggestion(projectId, suggestionId);
	if (!suggestion) throw new RouteValidationError("missing suggestion", 404);
	if (suggestion.status === "created") throw new RouteValidationError("created suggestion cannot be rejected", 409);
	const [updated] = await markAnnotationTaskSuggestions([suggestion.id], { status: "rejected" });
	return updated ?? suggestion;
}

export async function startAnnotationTaskApprovalRun(input: {
	projectId: string;
	suggestions: Array<{ id?: string | undefined; title: string; body: string; targetKind?: "task" | "run" | undefined; annotationIds?: string[] | undefined; worktreeId?: string | undefined; taskId?: string | undefined }>;
}) {
	const results = [];
	for (const suggestion of input.suggestions) {
		results.push(await approveAnnotationSuggestion({
			projectId: input.projectId,
			...(suggestion.id ? { suggestionId: suggestion.id } : {}),
			title: suggestion.title,
			body: suggestion.body,
			...(suggestion.targetKind ? { targetKind: suggestion.targetKind } : {}),
			...(suggestion.annotationIds?.length ? { annotationIds: suggestion.annotationIds } : {}),
			...(suggestion.worktreeId ? { worktreeId: suggestion.worktreeId } : {}),
			...(suggestion.taskId ? { taskId: suggestion.taskId } : {}),
		}));
	}
	return results;
}

export async function assertAnnotationWorktree(projectId: string, worktreeId: string) {
	return getWorktreeInProjectOrThrow(projectId, worktreeId);
}

export async function annotationRunsForProject(projectId: string) {
	const tasks = (await db.list<Task>("tasks")).filter((task) => task.projectId === projectId && (task.source === "annotation-run" || task.source === "annotation-tasks"));
	const taskIds = new Set(tasks.map((task) => task.id));
	return (await db.list<AgentRun>("runs")).filter((run) =>
		run.projectId === projectId && (
			Boolean(run.annotationIds?.length) ||
			run.lane === "annotation-tasks" ||
			taskIds.has(run.taskId)
		),
	);
}

export async function annotationSystemTasks(projectId: string) {
	return (await db.list<Task>("tasks")).filter((task) => task.projectId === projectId && (task.source === "annotation-run" || task.source === "annotation-tasks"));
}
