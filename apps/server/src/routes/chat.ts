import { Hono } from "hono";
import { listAgentProfilesForRun } from "../services/agentProfileService";
import { flueRuntime } from "../services/agentRuntime/flueRuntime";
import {
	listAnnotations,
	markAnnotationsProcessing,
} from "../services/annotationService";
import { assertAllowedWorktree } from "../services/projectService";

export const chat = new Hono();

chat.post("/", async (c) => {
	const body = await c.req.json();
	const worktree = await assertAllowedWorktree(body.worktreeId);
	const allAnnotations = await listAnnotations({ worktreeId: worktree.id });
	const ids = Array.isArray(body.annotationIds)
		? body.annotationIds
		: undefined;
	const annotations = ids
		? allAnnotations.filter((a) => ids.includes(a.id))
		: allAnnotations;
	const agents = await listAgentProfilesForRun(body.agentProfileId);
	const isAnnotationSent = Boolean(ids?.length);
	const run = await flueRuntime.startChat({
		projectId: body.projectId || "local",
		worktreeId: worktree.id,
		worktreePath: worktree.path,
		agents,
		message:
			body.message ||
			annotations.map((a) => a.text).join("\n") ||
			"Use annotations.",
		annotations,
		annotationIds: annotations.map((a) => a.id),
		taskTitle: isAnnotationSent ? "annotation-sent" : "task",
	});
	await markAnnotationsProcessing(
		annotations.map((a) => a.id),
		run.id,
	);
	return c.json(run);
});
