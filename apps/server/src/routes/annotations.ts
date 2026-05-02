import { Hono } from "hono";
import {
	createAnnotation,
	listAnnotations,
} from "../services/annotationService";

export const annotations = new Hono();
annotations.get("/", async (c) => {
	const filter: { taskId?: string; worktreeId?: string } = {};
	const taskId = c.req.query("taskId");
	const worktreeId = c.req.query("worktreeId");
	if (taskId) filter.taskId = taskId;
	if (worktreeId) filter.worktreeId = worktreeId;
	return c.json(await listAnnotations(filter));
});
annotations.post("/", async (c) =>
	c.json(await createAnnotation(await c.req.json())),
);
