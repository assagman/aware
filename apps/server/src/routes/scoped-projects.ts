import {
	graphArchiveTaskInputSchema,
	graphCreateTaskInputSchema,
	graphRetryRunInputSchema,
	graphSendRunMessageInputSchema,
	graphStartRunInputSchema,
	graphTaskIdentityInputSchema,
	graphUpdateTaskInputSchema,
} from "@aware/shared";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { archiveAnnotation, createAnnotation, listAnnotations, listAnnotationTaskSuggestions, restoreAnnotation } from "../services/annotationService";
import { annotationRunsForProject, approveAnnotationSuggestion, rejectAnnotationSuggestion, startAnnotationRun, startAnnotationTaskApprovalRun, startAnnotationTaskGeneratorRun } from "../services/annotationWorkflowService";
import { getGitDiff } from "../services/diffService";
import { listTree, readProjectFile } from "../services/fileService";
import { startGraphAgentRunCommand } from "../services/graphAgentRunner";
import {
	archiveTaskCommand,
	createCheckpointCommand,
	createTaskCommand,
	deleteRunCommand,
	markTaskDoneCommand,
	retryRunCommand,
	sendRunMessageCommand,
	startRunCommand,
	startShippingRunCommand,
	updateTaskCommand,
} from "../services/graph/commands";
import { buildGraphProjection } from "../services/graph/projection";
import {
	getProjectOrThrow,
	getRunInStoredTaskOrThrow,
	getRunInTaskOrThrow,
	getStoredTaskInProjectOrThrow,
	getWorktreeInProjectOrThrow,
	RouteValidationError,
} from "../services/graph/validation";
import type { DiffMode } from "../services/gitService";

export const scopedProjects = new Hono();

function errorResponse(c: Context, error: unknown) {
	if (error instanceof z.ZodError)
		return c.json({ error: "invalid request", issues: error.issues }, 400);
	if (error instanceof RouteValidationError)
		return c.json({ error: error.message }, error.status);
	return c.json(
		{ error: error instanceof Error ? error.message : String(error) },
		400,
	);
}

async function json(c: Context) {
	return c.req.json().catch(() => ({}));
}

const graphAgentRunInputSchema = z.object({
	mode: z.enum(["task_runs", "gate_runs", "ship_prep"]),
});

const createAnnotationInputSchema = z.object({
	worktreeId: z.string().min(1),
	kind: z.enum(["file", "line", "range", "diff"]),
	filePath: z.string().optional(),
	side: z.enum(["old", "new", "additions", "deletions"]).optional(),
	startLine: z.number().int().positive().optional(),
	endLine: z.number().int().positive().optional(),
	text: z.string().default(""),
	context: z.string().optional(),
	selectedText: z.string().optional(),
});

const annotationRunInputSchema = z.object({
	annotationIds: z.array(z.string().min(1)).min(1).optional(),
	message: z.string().optional(),
	mode: z.enum(["combined", "separate"]).default("combined"),
});

const annotationSuggestionInputSchema = z.object({
	annotationIds: z.array(z.string().min(1)).optional(),
	worktreeId: z.string().min(1).optional(),
});

const annotationSuggestionApprovalSchema = z.object({
	title: z.string().min(1).optional(),
	body: z.string().default("").optional(),
	targetKind: z.enum(["task", "run"]).optional(),
	annotationIds: z.array(z.string()).optional(),
	worktreeId: z.string().optional(),
	taskId: z.string().optional(),
});

const annotationTaskApprovalInputSchema = z.object({
	suggestions: z.array(z.object({
		id: z.string().optional(),
		title: z.string().min(1),
		body: z.string().default(""),
		targetKind: z.enum(["task", "run"]).optional(),
		annotationIds: z.array(z.string()).optional(),
		worktreeId: z.string().optional(),
		taskId: z.string().optional(),
	})).min(1),
});

scopedProjects.get("/:projectId", async (c) => {
	try {
		return c.json(await getProjectOrThrow(c.req.param("projectId")));
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.get("/:projectId/graph", async (c) => {
	try {
		await getProjectOrThrow(c.req.param("projectId"));
		return c.json(await buildGraphProjection(c.req.param("projectId"), { history: c.req.query("history") === "1" }));
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.get("/:projectId/annotations", async (c) => {
	try {
		await getProjectOrThrow(c.req.param("projectId"));
		const worktreeId = c.req.query("worktreeId");
		const stateQuery = c.req.query("state");
		const state = stateQuery === "archived" || stateQuery === "all" ? stateQuery : "active";
		if (worktreeId) await getWorktreeInProjectOrThrow(c.req.param("projectId"), worktreeId);
		return c.json(await listAnnotations({
			projectId: c.req.param("projectId"),
			state,
			...(worktreeId ? { worktreeId } : {}),
		}));
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/annotations", async (c) => {
	try {
		const body = createAnnotationInputSchema.parse(await json(c));
		await getWorktreeInProjectOrThrow(c.req.param("projectId"), body.worktreeId);
		return c.json(await createAnnotation({
			projectId: c.req.param("projectId"),
			worktreeId: body.worktreeId,
			kind: body.kind,
			text: body.text,
			...(body.filePath ? { filePath: body.filePath } : {}),
			...(body.side ? { side: body.side } : {}),
			...(body.startLine ? { startLine: body.startLine } : {}),
			...(body.endLine ? { endLine: body.endLine } : {}),
			...(body.context ? { context: body.context } : {}),
			...(body.selectedText ? { selectedText: body.selectedText } : {}),
		}));
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.get("/:projectId/annotations/history", async (c) => {
	try {
		await getProjectOrThrow(c.req.param("projectId"));
		const [annotations, runs, suggestions] = await Promise.all([
			listAnnotations({ projectId: c.req.param("projectId"), state: "all" }),
			annotationRunsForProject(c.req.param("projectId")),
			listAnnotationTaskSuggestions(c.req.param("projectId")),
		]);
		return c.json({
			annotations: annotations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
			runs: runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
			suggestions,
		});
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/annotations/:annotationId/archive", async (c) => {
	try {
		const annotation = await archiveAnnotation(c.req.param("projectId"), c.req.param("annotationId"));
		return annotation ? c.json(annotation) : c.json({ error: "missing annotation" }, 404);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/annotations/:annotationId/restore", async (c) => {
	try {
		const annotation = await restoreAnnotation(c.req.param("projectId"), c.req.param("annotationId"));
		return annotation ? c.json(annotation) : c.json({ error: "missing annotation" }, 404);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/annotations/:annotationId/runs", async (c) => {
	try {
		const body = annotationRunInputSchema.parse(await json(c));
		return c.json(await startAnnotationRun({
			projectId: c.req.param("projectId"),
			annotationIds: [c.req.param("annotationId")],
			...(body.message ? { message: body.message } : {}),
		}));
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/annotations/runs", async (c) => {
	try {
		const body = annotationRunInputSchema.parse(await json(c));
		const annotationIds = body.annotationIds ?? (await listAnnotations({ projectId: c.req.param("projectId"), state: "active" })).map((annotation) => annotation.id);
		if (body.mode === "separate")
			return c.json(await Promise.all(annotationIds.map((annotationId) => startAnnotationRun({
				projectId: c.req.param("projectId"),
				annotationIds: [annotationId],
				...(body.message ? { message: body.message } : {}),
			}))));
		return c.json(await startAnnotationRun({
			projectId: c.req.param("projectId"),
			annotationIds,
			...(body.message ? { message: body.message } : {}),
		}));
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.get("/:projectId/annotations/suggestions", async (c) => {
	try {
		await getProjectOrThrow(c.req.param("projectId"));
		return c.json(await listAnnotationTaskSuggestions(c.req.param("projectId")));
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/annotations/suggestions", async (c) => {
	try {
		const body = annotationSuggestionInputSchema.parse(await json(c));
		return c.json(await startAnnotationTaskGeneratorRun(c.req.param("projectId"), {
			...(body.annotationIds?.length ? { annotationIds: body.annotationIds } : {}),
			...(body.worktreeId ? { worktreeId: body.worktreeId } : {}),
		}));
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/annotations/suggestions/:suggestionId/approve", async (c) => {
	try {
		const body = annotationSuggestionApprovalSchema.parse(await json(c));
		return c.json(await approveAnnotationSuggestion({
			projectId: c.req.param("projectId"),
			suggestionId: c.req.param("suggestionId"),
			...(body.title ? { title: body.title } : {}),
			...(body.body ? { body: body.body } : {}),
			...(body.targetKind ? { targetKind: body.targetKind } : {}),
			...(body.annotationIds?.length ? { annotationIds: body.annotationIds } : {}),
			...(body.worktreeId ? { worktreeId: body.worktreeId } : {}),
			...(body.taskId ? { taskId: body.taskId } : {}),
		}));
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/annotations/suggestions/:suggestionId/reject", async (c) => {
	try {
		return c.json(await rejectAnnotationSuggestion(c.req.param("projectId"), c.req.param("suggestionId")));
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.get("/:projectId/annotation-tasks", async (c) => {
	try {
		await getProjectOrThrow(c.req.param("projectId"));
		return c.json(await listAnnotationTaskSuggestions(c.req.param("projectId")));
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/annotation-tasks/generate", async (c) => {
	try {
		return c.json(await startAnnotationTaskGeneratorRun(c.req.param("projectId")));
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/annotation-tasks/approve", async (c) => {
	try {
		const body = annotationTaskApprovalInputSchema.parse(await json(c));
		return c.json(await startAnnotationTaskApprovalRun({
			projectId: c.req.param("projectId"),
			suggestions: body.suggestions,
		}));
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/tasks", async (c) => {
	try {
		const body = await json(c);
		return c.json(
			await createTaskCommand(
				graphCreateTaskInputSchema.parse({
					...body,
					projectId: c.req.param("projectId"),
				}),
			),
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.get("/:projectId/tasks/:taskId", async (c) => {
	try {
		return c.json(
			await getStoredTaskInProjectOrThrow(
				c.req.param("projectId"),
				c.req.param("taskId"),
			),
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.patch("/:projectId/tasks/:taskId", async (c) => {
	try {
		const body = await json(c);
		return c.json(
			await updateTaskCommand(
				graphUpdateTaskInputSchema.parse({
					...body,
					projectId: c.req.param("projectId"),
					taskId: c.req.param("taskId"),
				}),
			),
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/tasks/:taskId/done", async (c) => {
	try {
		return c.json(
			await markTaskDoneCommand(
				graphTaskIdentityInputSchema.parse({
					projectId: c.req.param("projectId"),
					taskId: c.req.param("taskId"),
				}),
			),
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/tasks/:taskId/archive", async (c) => {
	try {
		const body = await json(c);
		return c.json(
			await archiveTaskCommand(
				graphArchiveTaskInputSchema.parse({
					...body,
					projectId: c.req.param("projectId"),
					taskId: c.req.param("taskId"),
				}),
			),
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/tasks/:taskId/checkpoints", async (c) => {
	try {
		return c.json(
			await createCheckpointCommand(
				graphTaskIdentityInputSchema.parse({
					projectId: c.req.param("projectId"),
					taskId: c.req.param("taskId"),
				}),
			),
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/tasks/:taskId/ship", async (c) => {
	try {
		return c.json(
			await startShippingRunCommand(
				graphTaskIdentityInputSchema.parse({
					projectId: c.req.param("projectId"),
					taskId: c.req.param("taskId"),
				}),
			),
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/tasks/:taskId/graph-agent", async (c) => {
	try {
		const body = graphAgentRunInputSchema.parse(await json(c));
		return c.json(
			await startGraphAgentRunCommand({
				projectId: c.req.param("projectId"),
				taskId: c.req.param("taskId"),
				mode: body.mode,
			}),
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/tasks/:taskId/runs", async (c) => {
	try {
		const body = await json(c);
		return c.json(
			await startRunCommand(
				graphStartRunInputSchema.parse({
					...body,
					projectId: c.req.param("projectId"),
					taskId: c.req.param("taskId"),
				}),
			),
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.get("/:projectId/tasks/:taskId/runs/:runId", async (c) => {
	try {
		return c.json(
			await getRunInStoredTaskOrThrow(
				c.req.param("projectId"),
				c.req.param("taskId"),
				c.req.param("runId"),
			),
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/tasks/:taskId/runs/:runId/messages", async (c) => {
	try {
		const body = await json(c);
		return c.json(
			await sendRunMessageCommand(
				graphSendRunMessageInputSchema.parse({
					...body,
					projectId: c.req.param("projectId"),
					taskId: c.req.param("taskId"),
					runId: c.req.param("runId"),
				}),
			),
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.post("/:projectId/tasks/:taskId/runs/:runId/retry", async (c) => {
	try {
		const body = await json(c);
		return c.json(
			await retryRunCommand(
				graphRetryRunInputSchema.parse({
					...body,
					projectId: c.req.param("projectId"),
					taskId: c.req.param("taskId"),
					runId: c.req.param("runId"),
				}),
			),
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.delete("/:projectId/tasks/:taskId/runs/:runId", async (c) => {
	try {
		return c.json(
			await deleteRunCommand({
				projectId: c.req.param("projectId"),
				taskId: c.req.param("taskId"),
				runId: c.req.param("runId"),
			}),
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.get("/:projectId/worktrees/:worktreeId", async (c) => {
	try {
		return c.json(
			await getWorktreeInProjectOrThrow(
				c.req.param("projectId"),
				c.req.param("worktreeId"),
			),
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.get("/:projectId/worktrees/:worktreeId/files", async (c) => {
	try {
		await getWorktreeInProjectOrThrow(
			c.req.param("projectId"),
			c.req.param("worktreeId"),
		);
		return c.json(
			await listTree(c.req.param("worktreeId"), c.req.query("path") ?? ""),
		);
	} catch (error) {
		return errorResponse(c, error);
	}
});

scopedProjects.get("/:projectId/worktrees/:worktreeId/files/content", async (c) => {
	try {
		await getWorktreeInProjectOrThrow(
			c.req.param("projectId"),
			c.req.param("worktreeId"),
		);
		return c.text(
			await readProjectFile(
				c.req.param("worktreeId"),
				c.req.query("path") ?? "",
			),
		);
	} catch (error) {
		return c.text(error instanceof Error ? error.message : String(error), 400);
	}
});

scopedProjects.get("/:projectId/worktrees/:worktreeId/diffs", async (c) => {
	try {
		await getWorktreeInProjectOrThrow(
			c.req.param("projectId"),
			c.req.param("worktreeId"),
		);
		const mode = c.req.query("mode") as DiffMode | undefined;
		if (mode)
			return c.text(
				await getGitDiff(
					c.req.param("worktreeId"),
					mode,
					c.req.query("base") ?? "HEAD",
					c.req.query("commit") ?? "HEAD",
				),
			);
		const [committed, staged, unstaged] = await Promise.all([
			getGitDiff(c.req.param("worktreeId"), "main"),
			getGitDiff(c.req.param("worktreeId"), "staged"),
			getGitDiff(c.req.param("worktreeId"), "unstaged"),
		]);
		return c.json({ committed, staged, unstaged });
	} catch (error) {
		return errorResponse(c, error);
	}
});
