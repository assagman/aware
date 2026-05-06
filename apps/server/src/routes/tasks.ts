import type { AgentRun } from "@aware/shared";
import { Hono, type Context } from "hono";
import { db } from "../db/client";
import { listMainAgentsForRun } from "../services/shippingAgentService";
import { flueRuntime } from "../services/agentRuntime/flueRuntime";
import {
	assertAllowedWorktree,
	listProjects,
} from "../services/projectService";
import {
	allTaskRunsDone,
	createTask,
	listTasks,
	updateTask,
} from "../services/taskService";
import { worktreeAgent } from "../services/worktreeAgentService";

export const tasks = new Hono();
tasks.get("/", async (c) => {
	const filter: { projectId?: string } = {};
	const projectId = c.req.query("projectId");
	if (projectId === "") return c.json([]);
	if (projectId) filter.projectId = projectId;
	return c.json(await listTasks(filter));
});
tasks.post("/", async (c) => {
	const body = await c.req.json();
	if (!body.projectId) return c.json({ error: "missing project" }, 400);
	if (body.worktreeId) {
		const worktree = await assertAllowedWorktree(body.worktreeId);
		if (worktree.projectId !== body.projectId)
			return c.json({ error: "worktree does not belong to task project" }, 400);
	}
	return c.json(await createTask(body));
});
tasks.patch("/:id", async (c) => {
	const body = await c.req.json();
	const task = (await listTasks()).find((t) => t.id === c.req.param("id"));
	if (!task) return c.json({ error: "missing task" }, 404);
	if (body.worktreeId) {
		const worktree = await assertAllowedWorktree(body.worktreeId);
		if (worktree.projectId !== task.projectId)
			return c.json({ error: "worktree does not belong to task project" }, 400);
	}
	const patch = Object.fromEntries(
		["title", "body", "worktreeId", "archivedAt", "deletedAt"]
			.filter((key) => key in body)
			.map((key) => [
				key,
				key === "worktreeId" && !body[key] ? undefined : body[key],
			]),
	);
	return c.json(await updateTask(c.req.param("id"), patch));
});
tasks.post("/:id/done", async (c) => {
	const task = (await listTasks()).find((t) => t.id === c.req.param("id"));
	if (!task) return c.json({ error: "missing task" }, 404);
	if (task.status === "done") return c.json(task);
	if (!(await allTaskRunsDone(task.id)))
		return c.json({ error: "all runs must be marked done first" }, 409);
	return c.json(await updateTask(task.id, { status: "done" }));
});

async function startTaskRun(c: Context) {
	const task = (await listTasks()).find((t) => t.id === c.req.param("id"));
	if (!task) return c.json({ error: "missing task" }, 404);
	const body = await c.req.json().catch(() => ({}));
	const project = (await listProjects()).find((p) => p.id === task.projectId);
	if (!project) return c.json({ error: "missing project" }, 400);
	const requestedWorktreeId = body.worktreeId || task.worktreeId;
	const requestedWorktree = requestedWorktreeId
		? await assertAllowedWorktree(requestedWorktreeId)
		: undefined;
	if (requestedWorktree && requestedWorktree.projectId !== task.projectId)
		return c.json({ error: "worktree does not belong to task project" }, 400);
	const worktree = await worktreeAgent.ensureTaskWorktree(
		project,
		requestedWorktree
			? { ...task, worktreeId: requestedWorktree.id }
			: task,
	);
	const taskWorktreeInfo =
		requestedWorktree && requestedWorktree.id === worktree.id
			? `Task worktree: ${worktree.path} (${worktree.branch || "unknown branch"}).`
			: `Task worktree: Worktree agent created ${worktree.path} (${worktree.branch}).`;
	const message =
		typeof body.message === "string" && body.message.trim()
			? body.message.trim()
			: task.body;
	const relation = body.relation === "sequential" ? "sequential" : "parallel";
	const parentRunId =
		typeof body.parentRunId === "string" && body.parentRunId
			? body.parentRunId
			: undefined;
	if (parentRunId) {
		const activeRuns = (await db.list<AgentRun>("runs")).filter(
			(run) => run.taskId === task.id && !run.deletedAt,
		);
		const parentRun = activeRuns.find((run) => run.id === parentRunId);
		if (!parentRun) return c.json({ error: "missing parent run" }, 400);
		if (
			relation === "sequential" &&
			activeRuns.some(
				(run) => run.parentRunId === parentRunId && run.relation === "sequential",
			)
		)
			return c.json({ error: "sequential run already exists for parent" }, 409);
	}
	const runTask: typeof task = {
		...task,
		worktreeId: worktree.id,
		status: "running",
		body: `${taskWorktreeInfo}\n\nTask brief:\n${task.body}`,
	};
	await updateTask(task.id, { status: "running", worktreeId: worktree.id });
	const agents = await listMainAgentsForRun();
	return c.json(
		await flueRuntime.startRun({
			task: runTask,
			worktreeId: worktree.id,
			worktreePath: worktree.path,
			agents,
			message,
			relation,
			...(parentRunId ? { parentRunId } : {}),
		}),
	);
}

tasks.post("/:id/start", startTaskRun);
tasks.post("/:id/runs", startTaskRun);
