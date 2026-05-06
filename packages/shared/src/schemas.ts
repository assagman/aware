import { z } from "zod";

export const idSchema = z.string().min(1);
export const projectSchema = z.object({
	id: idSchema,
	name: z.string(),
	rootPath: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export const worktreeSchema = z.object({
	id: idSchema,
	projectId: idSchema,
	path: z.string(),
	branch: z.string(),
	baseBranch: z.string().optional(),
	deletedAt: z.string().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export const agentProfileSchema = z.object({
	id: idSchema,
	name: z.string(),
	provider: z.string(),
	model: z.string(),
	thinking: z.string().optional(),
	systemPrompt: z.string(),
	tools: z.array(z.string()),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export const taskSourceSchema = z.enum(["user", "direct-chat", "annotation-run", "annotation-tasks"]);
export const taskSchema = z.object({
	id: idSchema,
	projectId: idSchema,
	worktreeId: idSchema.optional(),
	title: z.string(),
	body: z.string(),
	status: z.enum(["draft", "queued", "running", "need_review", "done", "failed"]),
	source: taskSourceSchema.optional(),
	annotationIds: z.array(idSchema).optional(),
	annotationTaskSuggestionId: idSchema.optional(),
	sourceAnnotationIds: z.array(idSchema).optional(),
	archivedAt: z.string().optional(),
	deletedAt: z.string().optional(),
	reviewInvalidatedAt: z.string().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export const annotationSchema = z.object({
	id: idSchema,
	projectId: idSchema,
	worktreeId: idSchema,
	taskId: idSchema.optional(),
	kind: z.enum(["file", "line", "range", "diff"]),
	filePath: z.string().optional(),
	side: z.enum(["old", "new", "additions", "deletions"]).optional(),
	startLine: z.number().optional(),
	endLine: z.number().optional(),
	text: z.string(),
	context: z.string().optional(),
	selectedText: z.string().optional(),
	sent: z.boolean(),
	status: z.enum(["pending", "processing", "sent"]).optional(),
	runId: idSchema.optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export const annotationTaskSuggestionSchema = z.object({
	id: idSchema,
	projectId: idSchema,
	title: z.string(),
	body: z.string(),
	status: z.enum(["draft", "approved", "creating", "created"]),
	sourceRunId: idSchema.optional(),
	annotationIds: z.array(idSchema).optional(),
	taskId: idSchema.optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export const runArtifactSchema = z.object({
	id: idSchema,
	projectId: idSchema,
	taskId: idSchema,
	runId: idSchema,
	worktreeId: idSchema,
	kind: z.literal("session_report"),
	turnSeq: z.number().int().positive(),
	lane: z.enum(["task", "gate", "ship", "graph", "annotation", "annotation-tasks"]).optional(),
	parentRunId: idSchema.optional(),
	title: z.string(),
	body: z.string(),
	metadata: z.record(z.unknown()).optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export const artifactorySaveSessionReportInputSchema = z.object({
	title: z.string().min(1).optional(),
	body: z.string().min(1),
	metadata: z.record(z.unknown()).optional(),
});

export const graphCreateProjectInputSchema = z.object({
	path: z.string().min(1),
});
export const graphCreateTaskInputSchema = z.object({
	projectId: idSchema,
	title: z.string().min(1),
	body: z.string().default(""),
	worktreeId: idSchema.optional(),
	annotationTaskSuggestionId: idSchema.optional(),
	sourceAnnotationIds: z.array(idSchema).optional(),
});
export const graphUpdateTaskInputSchema = z.object({
	projectId: idSchema,
	taskId: idSchema,
	title: z.string().min(1).optional(),
	body: z.string().optional(),
	worktreeId: idSchema.nullish(),
	archivedAt: z.string().nullish(),
	deletedAt: z.string().nullish(),
});
export const graphTaskIdentityInputSchema = z.object({
	projectId: idSchema,
	taskId: idSchema,
});
export const graphArchiveTaskInputSchema = graphTaskIdentityInputSchema.extend({
	cleanup: z.boolean().optional(),
	status: z.enum(["draft", "queued", "running", "need_review", "done", "failed"]).optional(),
});
export const graphStartRunInputSchema = z.object({
	projectId: idSchema,
	taskId: idSchema,
	message: z.string().optional(),
	worktreeId: idSchema.optional(),
	relation: z.enum(["parallel", "sequential"]).default("parallel"),
	lane: z.enum(["task", "gate"]).optional(),
	parentRunId: idSchema.optional(),
});
export const graphRunIdentityInputSchema = z.object({
	projectId: idSchema,
	taskId: idSchema,
	runId: idSchema,
});
export const graphSendRunMessageInputSchema = graphRunIdentityInputSchema.extend({
	message: z.string().min(1),
});
export const graphRetryRunInputSchema = graphRunIdentityInputSchema.extend({
	message: z.string().optional(),
});
export const graphOpenProjectInputSchema = z.object({ projectId: idSchema });
export const graphOpenTaskInputSchema = graphTaskIdentityInputSchema;
export const graphOpenRunInputSchema = graphRunIdentityInputSchema;
export const graphOpenCheckpointInputSchema = graphTaskIdentityInputSchema;
export const graphOpenShipInputSchema = graphTaskIdentityInputSchema;
export const graphOpenFilesInputSchema = z.object({
	projectId: idSchema,
	worktreeId: idSchema,
	path: z.string().optional(),
});
export const graphOpenDiffsInputSchema = z.object({
	projectId: idSchema,
	worktreeId: idSchema,
	file: z.string().optional(),
});
export const graphOpenAnnotationsInputSchema = z.object({
	projectId: idSchema,
	worktreeId: idSchema.optional(),
});
export const graphOpenAnnotationTasksInputSchema = z.object({ projectId: idSchema });
export const graphSaveAnnotationTaskSuggestionsInputSchema = z.object({
	projectId: idSchema,
	suggestions: z.array(z.object({
		title: z.string().min(1),
		body: z.string().default(""),
		annotationIds: z.array(idSchema).optional(),
	})).min(1),
});

export const graphCommandSchemas = {
	create_project: graphCreateProjectInputSchema,
	create_task: graphCreateTaskInputSchema,
	update_task: graphUpdateTaskInputSchema,
	mark_task_done: graphTaskIdentityInputSchema,
	archive_task: graphArchiveTaskInputSchema,
	start_run: graphStartRunInputSchema,
	send_run_message: graphSendRunMessageInputSchema,
	retry_run: graphRetryRunInputSchema,
	delete_run: graphRunIdentityInputSchema,
	create_checkpoint: graphTaskIdentityInputSchema,
	start_shipping: graphTaskIdentityInputSchema,
	open_project: graphOpenProjectInputSchema,
	open_checkpoint: graphOpenCheckpointInputSchema,
	open_ship: graphOpenShipInputSchema,
	open_task: graphOpenTaskInputSchema,
	open_run: graphOpenRunInputSchema,
	open_files: graphOpenFilesInputSchema,
	open_diffs: graphOpenDiffsInputSchema,
	open_annotations: graphOpenAnnotationsInputSchema,
	open_annotation_tasks: graphOpenAnnotationTasksInputSchema,
} as const;

export type GraphCommandSchemaName = keyof typeof graphCommandSchemas;
