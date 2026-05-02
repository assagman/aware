import { Hono } from "hono";
import { listAgentProfiles } from "../services/agentProfileService";
import { flueRuntime } from "../services/agentRuntime/flueRuntime";
import { assertAllowedWorktree } from "../services/projectService";
import {
	assignAgent,
	createTask,
	listTasks,
	updateTask,
} from "../services/taskService";

export const tasks = new Hono();
tasks.get("/", async (c) => c.json(await listTasks()));
tasks.post("/", async (c) => c.json(await createTask(await c.req.json())));
tasks.post("/:id/agents", async (c) => {
	const body = await c.req.json();
	return c.json(
		await assignAgent(c.req.param("id"), body.agentProfileId, body.role),
	);
});
tasks.post("/:id/start", async (c) => {
	const task = (await listTasks()).find((t) => t.id === c.req.param("id"));
	if (!task) return c.json({ error: "missing task" }, 404);
	await updateTask(task.id, { status: "running" });
	const worktree = await assertAllowedWorktree(task.worktreeId);
	const agents = await listAgentProfiles();
	return c.json(
		await flueRuntime.startRun({ task, worktreePath: worktree.path, agents }),
	);
});
