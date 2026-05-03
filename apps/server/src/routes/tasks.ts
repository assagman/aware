import { Hono } from "hono";
import { listAgentProfilesForRun } from "../services/agentProfileService";
import { flueRuntime } from "../services/agentRuntime/flueRuntime";
import {
	assertAllowedWorktree,
	listWorktrees,
} from "../services/projectService";
import {
	assignAgent,
	createTask,
	listTasks,
	updateTask,
} from "../services/taskService";

export const tasks = new Hono();
tasks.get("/", async (c) => {
	const filter: { projectId?: string } = {};
	const projectId = c.req.query("projectId");
	if (projectId) filter.projectId = projectId;
	return c.json(await listTasks(filter));
});
tasks.post("/", async (c) => c.json(await createTask(await c.req.json())));
tasks.patch("/:id", async (c) => {
	const body = await c.req.json();
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
	const worktreeId = body.worktreeId || task.worktreeId;
	const worktree = worktreeId
		? await assertAllowedWorktree(worktreeId)
		: (await listWorktrees()).find((w) => w.projectId === task.projectId);
	if (!worktree) return c.json({ error: "missing worktree" }, 400);
	const taskWorktreeInfo = task.worktreeId
		? `Task worktree: attached worktree ${worktree.path} (${worktree.branch || "unknown branch"}).`
		: "Task worktree: new worktree requested. Create a new non-default git worktree for this task before mutating files.";
	const runTask: typeof task = {
		...task,
		body: `${taskWorktreeInfo}\n\n${task.body}`,
	};
	await updateTask(task.id, { status: "running" });
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
