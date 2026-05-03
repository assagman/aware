import type { Worktree } from "@aware/shared";
import { git, statusShort } from "./gitService";

const defaultBranches = new Set(["main", "master"]);

export function isDefaultBranch(worktree: Pick<Worktree, "branch">) {
	return defaultBranches.has(worktree.branch);
}

function describeStatus(status: string) {
	const reverted: string[] = [];
	const deleted: string[] = [];
	for (const line of status.split("\n").filter(Boolean)) {
		const code = line.slice(0, 2);
		const file = line.slice(3).trim();
		if (!file) continue;
		if (code.includes("?")) deleted.push(file);
		else reverted.push(file);
	}
	return { reverted, deleted };
}

export async function revertDefaultBranchMutation(worktree: Worktree) {
	if (!isDefaultBranch(worktree)) return undefined;
	const status = await statusShort(worktree.path);
	if (!status.trim()) return undefined;
	const { reverted, deleted } = describeStatus(status);
	await git(worktree.path, ["reset", "--hard", "HEAD"]);
	await git(worktree.path, ["clean", "-fd"]);
	return [
		"Mutation is not allowed in default branch, you MUST create a new worktree.",
		reverted.length ? `Reverted ${reverted.join(", ")} file changes.` : "",
		deleted.length ? `Deleted ${deleted.join(", ")} files.` : "",
	]
		.filter(Boolean)
		.join(" ");
}
