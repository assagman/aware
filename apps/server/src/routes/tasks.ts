import { Hono } from "hono";
import { listAgentProfilesForRun } from "../services/agentProfileService";
import { flueRuntime } from "../services/agentRuntime/flueRuntime";
import { assertAllowedWorktree } from "../services/projectService";
import {
	assignAgent,
	createTask,
	listTasks,
	updateTask,
} from "../services/taskService";

export const tasks = new Hono();
tasks.get("/", async (c) => {
	const filter: { projectId?: string; worktreeId?: string } = {};
	const projectId = c.req.query("projectId");
	const worktreeId = c.req.query("worktreeId");
	if (projectId) filter.projectId = projectId;
	if (worktreeId) filter.worktreeId = worktreeId;
	return c.json(await listTasks(filter));
});
tasks.post("/", async (c) => c.json(await createTask(await c.req.json())));
tasks.patch("/:id", async (c) => {
	const body = await c.req.json();
	return c.json(
		await updateTask(c.req.param("id"), {
			title: body.title,
			body: body.body,
		}),
	);
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
	await updateTask(task.id, { status: "running" });
	const worktree = await assertAllowedWorktree(task.worktreeId);
	const body = await c.req.json().catch(() => ({}));
	const agents = await listAgentProfilesForRun(body.agentProfileId);
	return c.json(
		await flueRuntime.startRun({ task, worktreePath: worktree.path, agents }),
	);
});
