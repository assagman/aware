import { Hono } from "hono";
import { listAgentProfiles } from "../services/agentProfileService";
import { flueRuntime } from "../services/agentRuntime/flueRuntime";
import {
	listAnnotations,
	markAnnotationsSent,
} from "../services/annotationService";
import { assertAllowedWorktree } from "../services/projectService";

export const chat = new Hono();

chat.post("/", async (c) => {
	const body = await c.req.json();
	const worktree = await assertAllowedWorktree(body.worktreeId);
	const annotations = await listAnnotations({ worktreeId: worktree.id });
	const agents = await listAgentProfiles();
	const run = await flueRuntime.startChat({
		projectId: body.projectId || "local",
		worktreeId: worktree.id,
		worktreePath: worktree.path,
		agents,
		message: body.message,
		annotations,
	});
	await markAnnotationsSent(annotations.map((a) => a.id));
	return c.json(run);
});
