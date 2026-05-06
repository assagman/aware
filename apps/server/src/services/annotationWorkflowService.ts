import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentRun, Annotation, AnnotationTaskSuggestion, Project, Task, Worktree } from "@aware/shared";
import { db } from "../db/client";
import { flueRuntime } from "./agentRuntime/flueRuntime";
import { git, worktreeRoot } from "./gitService";
import { getProjectOrThrow, getWorktreeInProjectOrThrow, RouteValidationError } from "./graph/validation";
import { addWorktree, listWorktrees } from "./projectService";
import { listGraphAgentsForRun } from "./graphAgentService";
import { listMainAgentsForRun } from "./shippingAgentService";
import { createTask } from "./taskService";
import { worktreePathForBranch } from "./workspaceConvention";
import { withQueuedLock } from "./worktreeLock";
import {
	annotationLocation,
	getAnnotationInProject,
	listAnnotations,
	listAnnotationTaskSuggestions,
	markAnnotationsProcessing,
	markAnnotationTaskSuggestions,
	saveAnnotationTaskSuggestions,
	serializeAnnotations,
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

function annotationRunMessage(annotations: Annotation[]) {
	return [
		"Handle these Aware annotations in isolation.",
		"Use annotation context exactly; preserve file paths and line ranges when editing.",
		"If multiple annotations conflict, report tradeoffs before broad changes.",
		"",
		"Annotations:",
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
	const message = input.message?.trim() || annotationRunMessage(annotations);
	const run = await flueRuntime.startChat({
		projectId: project.id,
		worktreeId: worktree.id,
		worktreePath: worktree.path,
		agents,
		message,
		annotations: annotations.map((annotation) => ({ ...annotation, worktreeId: worktree.id })),
		annotationIds: annotations.map((annotation) => annotation.id),
		taskTitle: annotations.length === 1 ? `Annotation: ${annotationLocation(annotations[0]!)}` : `Annotations: ${annotations.length}`,
		taskSource: "annotation-run",
		lane: "annotation",
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

async function createAnnotationTasksSystemTask(project: Project, title: string, body: string, worktree: Worktree) {
	return createTask({
		projectId: project.id,
		worktreeId: worktree.id,
		title,
		body,
		source: "annotation-tasks",
	});
}

export async function startAnnotationTaskGeneratorRun(projectId: string) {
	const project = await getProjectOrThrow(projectId);
	const worktree = projectWorktree(project, await listWorktrees());
	if (!worktree) throw new RouteValidationError("project has no worktree for annotation task generator", 409);
	const annotations = await listAnnotations({ projectId: project.id });
	const task = await createAnnotationTasksSystemTask(
		project,
		"Annotation task generator",
		serializeAnnotations(annotations) || "No annotations yet.",
		worktree,
	);
	const agents = await listGraphAgentsForRun();
	const message = [
		"Mode: annotation_task_suggestions",
		`Project id: ${project.id}`,
		"Use graph_get_projection to inspect annotations, annotation runs, current tasks, and worktrees.",
		"Recommend isolated, non-overlapping implementation tasks that consume prior annotation runs.",
		"Call graph_save_annotation_task_suggestions with concise task titles/bodies and relevant annotationIds.",
		"Do not call graph_create_task. User approval required before task creation.",
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

async function prepareApprovedSuggestions(input: {
	projectId: string;
	suggestions: Array<{ id?: string | undefined; title: string; body: string; annotationIds?: string[] | undefined }>;
}) {
	const existing = new Map((await listAnnotationTaskSuggestions(input.projectId)).map((row) => [row.id, row]));
	const prepared: AnnotationTaskSuggestion[] = [];
	for (const suggestion of input.suggestions) {
		const title = suggestion.title.trim();
		if (!title) continue;
		if (suggestion.id && existing.has(suggestion.id)) {
			const updated = await db.update<AnnotationTaskSuggestion>("annotationTaskSuggestions", suggestion.id, {
				title,
				body: suggestion.body,
				status: "creating",
				...(suggestion.annotationIds?.length ? { annotationIds: suggestion.annotationIds } : {}),
				updatedAt: now(),
			});
			if (updated) prepared.push(updated);
			continue;
		}
		const [created] = await saveAnnotationTaskSuggestions({
			projectId: input.projectId,
			suggestions: [{ title, body: suggestion.body, annotationIds: suggestion.annotationIds }],
		});
		if (created) {
			await markAnnotationTaskSuggestions([created.id], { status: "creating" });
			prepared.push({ ...created, status: "creating" });
		}
	}
	if (!prepared.length) throw new RouteValidationError("missing approved suggestions", 400);
	return prepared;
}

export async function startAnnotationTaskApprovalRun(input: {
	projectId: string;
	suggestions: Array<{ id?: string | undefined; title: string; body: string; annotationIds?: string[] | undefined }>;
}) {
	const project = await getProjectOrThrow(input.projectId);
	const worktree = projectWorktree(project, await listWorktrees());
	if (!worktree) throw new RouteValidationError("project has no worktree for annotation task approval", 409);
	const suggestions = await prepareApprovedSuggestions(input);
	const task = await createAnnotationTasksSystemTask(
		project,
		"Approved annotation tasks",
		JSON.stringify(suggestions, null, 2),
		worktree,
	);
	const agents = await listGraphAgentsForRun();
	const message = [
		"Mode: approved_annotation_task_creation",
		`Project id: ${project.id}`,
		"Create exactly these user-approved tasks via graph_create_task.",
		"For each item, pass annotationTaskSuggestionId and sourceAnnotationIds when provided.",
		"Do not start runs. Do not create extra tasks. Avoid duplicates only if an identical task already exists.",
		"",
		"Approved suggestions JSON:",
		JSON.stringify(suggestions.map((suggestion) => ({
			annotationTaskSuggestionId: suggestion.id,
			title: suggestion.title,
			body: suggestion.body,
			sourceAnnotationIds: suggestion.annotationIds ?? [],
		})), null, 2),
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

export async function assertAnnotationWorktree(projectId: string, worktreeId: string) {
	return getWorktreeInProjectOrThrow(projectId, worktreeId);
}

export async function annotationRunsForProject(projectId: string) {
	return (await db.list<AgentRun>("runs")).filter((run) => run.projectId === projectId && (run.lane === "annotation" || run.lane === "annotation-tasks"));
}

export async function annotationSystemTasks(projectId: string) {
	return (await db.list<Task>("tasks")).filter((task) => task.projectId === projectId && (task.source === "annotation-run" || task.source === "annotation-tasks"));
}
