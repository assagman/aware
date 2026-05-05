import { Hono } from "hono";
import { listTree, readProjectFile } from "../services/fileService";

export const files = new Hono();
files.get("/tree", async (c) => {
	const worktreeId = c.req.query("worktreeId") ?? "";
	if (!worktreeId) return c.json([]);
	return c.json(await listTree(worktreeId, c.req.query("path") ?? ""));
});
files.get("/read", async (c) => {
	const worktreeId = c.req.query("worktreeId") ?? "";
	if (!worktreeId) return c.text("");
	return c.text(await readProjectFile(worktreeId, c.req.query("path") ?? ""));
});
