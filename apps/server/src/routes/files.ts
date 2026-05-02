import { Hono } from "hono";
import { listTree, readProjectFile } from "../services/fileService";

export const files = new Hono();
files.get("/tree", async (c) =>
	c.json(
		await listTree(c.req.query("worktreeId") ?? "", c.req.query("path") ?? ""),
	),
);
files.get("/read", async (c) =>
	c.text(
		await readProjectFile(
			c.req.query("worktreeId") ?? "",
			c.req.query("path") ?? "",
		),
	),
);
