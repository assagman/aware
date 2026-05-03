import { Hono } from "hono";
import { listAgentProfilesForRun } from "../services/agentProfileService";
import { flueRuntime } from "../services/agentRuntime/flueRuntime";
import {
	assertAllowedWorktree,
	listProjects,
} from "../services/projectService";
import {
	assignAgent,
	createTask,
	listTasks,
	updateTask,
} from "../services/taskService";
import { worktreeAgent } from "../services/worktreeAgentService";

export const tasks = new Hono();
tasks.get("/", async (c) => {
	const filter: { projectId?: string } = {};
	const projectId = c.req.query("projectId");
	if (projectId) filter.projectId = projectId;
	return c.json(await listTasks(filter));
});
tasks.post("/", async (c) => {
	const body = await c.req.json();
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
tasks.post("/:id/agents", async (c) => {
	const body = await c.req.json();
	return c.json(
		await assignAgent(c.req.param("id"), body.agentProfileId, body.role),
	);
});
tasks.post("/:id/start", async (c) => {
	const task = (await listTasks()).find((t) => t.id === c.req.param("id"));
	if (!task) return c.json({ error: "missing task" }, 404);
	if (task.status === "done" || task.status === "running")
		return c.json({ error: `task is ${task.status}` }, 409);
	const body = await c.req.json().catch(() => ({}));
	const project = (await listProjects()).find((p) => p.id === task.projectId);
	if (!project) return c.json({ error: "missing project" }, 400);
	const requestedWorktreeId = body.worktreeId || task.worktreeId;
	const worktree = requestedWorktreeId
		? await assertAllowedWorktree(requestedWorktreeId)
		: await worktreeAgent.ensureTaskWorktree(project, task);
	if (worktree.projectId !== task.projectId)
		return c.json({ error: "worktree does not belong to task project" }, 400);
	const taskWorktreeInfo = requestedWorktreeId
		? `Task worktree: attached worktree ${worktree.path} (${worktree.branch || "unknown branch"}).`
		: `Task worktree: Worktree agent created ${worktree.path} (${worktree.branch}).`;
	const runTask: typeof task = {
		...task,
		worktreeId: worktree.id,
		body: `${taskWorktreeInfo}\n\n${task.body}`,
	};
	await updateTask(task.id, { status: "running", worktreeId: worktree.id });
	const agents = await listAgentProfilesForRun(body.agentProfileId);
	return c.json(
		await flueRuntime.startRun({
			task: runTask,
			worktreeId: worktree.id,
			worktreePath: worktree.path,
			agents,
		}),
	);
});
