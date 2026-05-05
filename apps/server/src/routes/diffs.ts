import { Hono } from "hono";
import { getGitCommits, getGitDiff } from "../services/diffService";
import type { DiffMode } from "../services/gitService";

export const diffs = new Hono();
diffs.get("/git", async (c) => {
	const worktreeId = c.req.query("worktreeId") ?? "";
	if (!worktreeId) return c.text("");
	const mode = (c.req.query("mode") ?? "unstaged") as DiffMode;
	return c.text(
		await getGitDiff(
			worktreeId,
			mode,
			c.req.query("base") ?? "HEAD",
			c.req.query("commit") ?? "HEAD",
		),
	);
});

diffs.get("/commits", async (c) => {
	const worktreeId = c.req.query("worktreeId") ?? "";
	if (!worktreeId) return c.json([]);
	return c.json(await getGitCommits(worktreeId));
});
