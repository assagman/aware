import { currentBranch, diff, statusShort } from "./gitService";
import { assertAllowedWorktree } from "./projectService";

export async function getWorktreeStatus(worktreeId: string) {
	const worktree = await assertAllowedWorktree(worktreeId);
	return {
		branch: await currentBranch(worktree.path),
		status: await statusShort(worktree.path),
	};
}

export async function getGitDiff(
	worktreeId: string,
	mode: "unstaged" | "staged" | "base" = "unstaged",
	base = "HEAD",
) {
	const worktree = await assertAllowedWorktree(worktreeId);
	return diff(worktree.path, mode, base);
}
