import { Hono } from "hono";
import {
	createAnnotation,
	getAnnotationInProject,
	listAnnotations,
	updateAnnotation,
} from "../services/annotationService";

export const annotations = new Hono();
annotations.get("/", async (c) => {
	const filter: { projectId?: string; taskId?: string; worktreeId?: string; state?: "active" | "archived" | "all" } = {};
	const projectId = c.req.query("projectId");
	const taskId = c.req.query("taskId");
	const worktreeId = c.req.query("worktreeId");
	if (projectId) filter.projectId = projectId;
	if (taskId) filter.taskId = taskId;
	if (worktreeId) filter.worktreeId = worktreeId;
	const includeArchived = c.req.query("includeArchived") === "1" || c.req.query("includeArchived") === "true";
	const archivedOnly = c.req.query("archivedOnly") === "1" || c.req.query("archivedOnly") === "true";
	if (archivedOnly) filter.state = "archived";
	else if (includeArchived) filter.state = "all";
	return c.json(await listAnnotations(filter));
});
annotations.post("/", async (c) =>
	c.json(await createAnnotation(await c.req.json())),
);
annotations.patch("/:id", async (c) => {
	const body = await c.req.json();
	const existing = body.projectId
		? await getAnnotationInProject(body.projectId, c.req.param("id"), "all")
		: (await listAnnotations({ state: "all" })).find((a) => a.id === c.req.param("id"));
	if (!existing) return c.json({ error: "missing annotation" }, 404);
	const patch = Object.fromEntries(
		["taskId", "kind", "filePath", "side", "startLine", "endLine", "text", "context", "selectedText", "sent", "status", "runId", "archivedAt"]
			.filter((key) => key in body)
			.map((key) => [key, body[key] ?? undefined]),
	);
	return c.json(await updateAnnotation(c.req.param("id"), patch));
});
