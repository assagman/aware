import { Type, type ToolDef } from "@flue/sdk/client";
import {
	graphCreateTaskInputSchema,
	graphRetryRunInputSchema,
	graphSaveAnnotationTaskSuggestionsInputSchema,
	graphRunIdentityInputSchema,
	graphSendRunMessageInputSchema,
	graphStartRunInputSchema,
	graphTaskIdentityInputSchema,
	graphUpdateTaskInputSchema,
} from "@aware/shared";

const graphToolNames = [
	"graph_get_projection",
	"graph_create_task",
	"graph_update_task",
	"graph_start_run",
	"graph_send_run_message",
	"graph_retry_run",
	"graph_delete_run",
	"graph_create_checkpoint",
	"graph_save_annotation_task_suggestions",
] as const;

export type GraphToolName = (typeof graphToolNames)[number];
export const GRAPH_TOOL_NAMES: readonly GraphToolName[] = graphToolNames;

function stringifyResult(result: unknown) {
	return JSON.stringify(result, null, 2);
}

const projectId = Type.String({ description: "Project id." });
const taskId = Type.String({ description: "Task id." });
const runId = Type.String({ description: "Run id." });
const optionalText = (description: string) => Type.Optional(Type.String({ description }));

export function createGraphTools(): ToolDef[] {
	return [
		{
			name: "graph_get_projection",
			description: "Read current Aware graph projection. Use before changing graph state.",
			parameters: Type.Object({
				projectId: Type.Optional(projectId),
			}),
			execute: async (args) => {
				const { buildGraphProjection } = await import("../../services/graph/projection");
				const id = typeof args.projectId === "string" && args.projectId ? args.projectId : undefined;
				return stringifyResult(await buildGraphProjection(id));
			},
		},
		{
			name: "graph_create_task",
			description: "Create a task node in a project graph. Optional worktreeId attaches an existing project worktree; omit for a new task worktree later.",
			parameters: Type.Object({
				projectId,
				title: Type.String({ description: "Task title." }),
				body: optionalText("Task markdown/details."),
				worktreeId: optionalText("Existing worktree id to attach."),
				annotationTaskSuggestionId: optionalText("Approved annotation task suggestion id, when creating from AnnotationTasks."),
				sourceAnnotationIds: Type.Optional(Type.Array(Type.String({ description: "Source annotation id." }))),
			}),
			execute: async (args) => {
				const { createTaskCommand } = await import("../../services/graph/commands");
				return stringifyResult(await createTaskCommand(graphCreateTaskInputSchema.parse(args)));
			},
		},
		{
			name: "graph_update_task",
			description: "Update an existing task node title/body/worktree/archive/delete fields.",
			parameters: Type.Object({
				projectId,
				taskId,
				title: optionalText("New task title."),
				body: optionalText("New task markdown/details."),
				worktreeId: optionalText("Existing worktree id to attach; omit to keep current."),
				archivedAt: optionalText("ISO timestamp to archive."),
				deletedAt: optionalText("ISO timestamp to soft-delete."),
			}),
			execute: async (args) => {
				const { updateTaskCommand } = await import("../../services/graph/commands");
				return stringifyResult(await updateTaskCommand(graphUpdateTaskInputSchema.parse(args)));
			},
		},
		{
			name: "graph_start_run",
			description: "Start a task-lane or gate-lane agent run. Use lane 'task' for implementation splits, 'gate' for validation/ship-prep evidence. Never use this for final shipping.",
			parameters: Type.Object({
				projectId,
				taskId,
				message: optionalText("Run instructions. Keep concrete, scoped, and non-overlapping."),
				worktreeId: optionalText("Existing project worktree id. Usually omit; task worktree is used."),
				relation: optionalText("'parallel' or 'sequential'. Defaults to parallel."),
				lane: optionalText("'task' or 'gate'. Defaults to task."),
				parentRunId: optionalText("Parent run id for sequential run."),
			}),
			execute: async (args) => {
				const { startRunCommand } = await import("../../services/graph/commands");
				return stringifyResult(await startRunCommand(graphStartRunInputSchema.parse(args)));
			},
		},
		{
			name: "graph_send_run_message",
			description: "Send a steering/continue message to an existing run.",
			parameters: Type.Object({
				projectId,
				taskId,
				runId,
				message: Type.String({ description: "Message to send." }),
			}),
			execute: async (args) => {
				const { sendRunMessageCommand } = await import("../../services/graph/commands");
				return stringifyResult(await sendRunMessageCommand(graphSendRunMessageInputSchema.parse(args)));
			},
		},
		{
			name: "graph_retry_run",
			description: "Retry an existing non-running run by creating a replacement run with the same request/lane.",
			parameters: Type.Object({
				projectId,
				taskId,
				runId,
				message: optionalText("Optional replacement request."),
			}),
			execute: async (args) => {
				const { retryRunCommand } = await import("../../services/graph/commands");
				return stringifyResult(await retryRunCommand(graphRetryRunInputSchema.parse(args)));
			},
		},
		{
			name: "graph_delete_run",
			description: "Soft-delete a run from active graph logic.",
			parameters: Type.Object({ projectId, taskId, runId }),
			execute: async (args) => {
				const { deleteRunCommand } = await import("../../services/graph/commands");
				return stringifyResult(await deleteRunCommand(graphRunIdentityInputSchema.parse(args)));
			},
		},
		{
			name: "graph_create_checkpoint",
			description: "Create/checkpoint task after task-lane runs are done. For Auto Gate, prefer starting gate runs instead of marking checkpoint directly.",
			parameters: Type.Object({ projectId, taskId }),
			execute: async (args) => {
				const { createCheckpointCommand } = await import("../../services/graph/commands");
				return stringifyResult(await createCheckpointCommand(graphTaskIdentityInputSchema.parse(args)));
			},
		},
		{
			name: "graph_save_annotation_task_suggestions",
			description: "Save draft task suggestions for the AnnotationTasks approval page. Use this instead of creating tasks when user approval is required.",
			parameters: Type.Object({
				projectId,
				suggestions: Type.Array(Type.Object({
					title: Type.String({ description: "Suggested task title." }),
					body: optionalText("Suggested task markdown/details."),
					annotationIds: Type.Optional(Type.Array(Type.String({ description: "Relevant annotation id." }))),
				})),
			}),
			execute: async (args) => {
				const { saveAnnotationTaskSuggestions } = await import("../../services/annotationService");
				return stringifyResult(await saveAnnotationTaskSuggestions(graphSaveAnnotationTaskSuggestionsInputSchema.parse(args)));
			},
		},
	];
}
