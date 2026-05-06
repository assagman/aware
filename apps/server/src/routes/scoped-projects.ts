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
