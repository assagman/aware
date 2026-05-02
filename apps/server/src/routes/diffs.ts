import { Hono } from "hono";
import { getGitDiff } from "../services/diffService";

export const diffs = new Hono();
diffs.get("/git", async (c) => {
	const worktreeId = c.req.query("worktreeId") ?? "";
	const mode = (c.req.query("mode") ?? "unstaged") as
		| "unstaged"
		| "staged"
		| "base";
	return c.text(
		await getGitDiff(worktreeId, mode, c.req.query("base") ?? "HEAD"),
	);
});
