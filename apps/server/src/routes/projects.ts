import { Hono } from "hono";
import {
	addProject,
	addWorktree,
	listProjects,
	listWorktrees,
} from "../services/projectService";

export const projects = new Hono();
projects.get("/", async (c) => c.json(await listProjects()));
projects.post("/", async (c) => {
	try {
		return c.json(await addProject((await c.req.json()).path));
	} catch (error) {
		return c.json(
			{ error: error instanceof Error ? error.message : String(error) },
			400,
		);
	}
});

export const worktrees = new Hono();
worktrees.get("/", async (c) => c.json(await listWorktrees()));
worktrees.post("/", async (c) => {
	try {
		const body = await c.req.json();
		return c.json(await addWorktree(body.projectId, body.path));
	} catch (error) {
		return c.json(
			{ error: error instanceof Error ? error.message : String(error) },
			400,
		);
	}
});
