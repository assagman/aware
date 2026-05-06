import { Hono } from "hono";
import { listMainAgentsForRun } from "../services/shippingAgentService";
import { flueRuntime } from "../services/agentRuntime/flueRuntime";
import {
	listAnnotations,
	markAnnotationsProcessing,
	moveAnnotationsToWorktree,
} from "../services/annotationService";
import {
	assertAllowedWorktree,
	listProjects,
} from "../services/projectService";
import { ensureMutableWorktree } from "../services/worktreeAgentService";

export const chat = new Hono();

chat.post("/", async (c) => {
	const body = await c.req.json();
	if (!body.worktreeId) return c.json({ error: "missing worktree" }, 400);
	const requestedWorktree = await assertAllowedWorktree(body.worktreeId);
	if (body.projectId && body.projectId !== requestedWorktree.projectId)
		return c.json({ error: "worktree does not belong to chat project" }, 400);
	const project = (await listProjects()).find(
		(p) => p.id === requestedWorktree.projectId,
	);
	if (!project) return c.json({ error: "missing project" }, 400);
	const allAnnotations = await listAnnotations({ worktreeId: requestedWorktree.id });
	const ids = Array.isArray(body.annotationIds)
		? body.annotationIds
		: undefined;
	const annotations = ids
		? allAnnotations.filter((a) => ids.includes(a.id))
		: allAnnotations;
	const message =
		body.message ||
		annotations.map((a) => a.text).join("\n") ||
		"Use annotations.";
	const isAnnotationSent = Boolean(ids?.length);
	const worktree = await ensureMutableWorktree(project, requestedWorktree, {
		title: isAnnotationSent ? "annotation-sent" : "chat",
		body: message,
	});
	if (worktree.id !== requestedWorktree.id && annotations.length)
		await moveAnnotationsToWorktree(
			annotations.map((a) => a.id),
			worktree.id,
			worktree.projectId,
		);
	const runAnnotations = annotations.map((annotation) => ({
		...annotation,
		projectId: worktree.projectId,
		worktreeId: worktree.id,
	}));
	const agents = await listMainAgentsForRun();
	const run = await flueRuntime.startChat({
		projectId: worktree.projectId,
		worktreeId: worktree.id,
		worktreePath: worktree.path,
		agents,
		message,
		annotations: runAnnotations,
		annotationIds: runAnnotations.map((a) => a.id),
		taskTitle: isAnnotationSent ? "annotation-sent" : "task",
	});
	await markAnnotationsProcessing(
		runAnnotations.map((a) => a.id),
		run.id,
	);
	return c.json(run);
});
