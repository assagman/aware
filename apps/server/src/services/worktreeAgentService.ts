import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Project, Task, Worktree } from "@aware/shared";
import { worktreePrompt } from "../flue/agents/worktree";
import { git, worktreeRoot } from "./gitService";
import { addWorktree, listWorktrees } from "./projectService";
import {
	SANDBOX_WORKSPACE_ROOT,
	worktreePathForBranch,
} from "./workspaceConvention";
import { withQueuedLock } from "./worktreeLock";
import {
	type ChangeCategory,
	classifyTaskChange,
	slugifyTask,
} from "./worktreeNaming";

async function branchExists(project: Project, branch: string) {
	try {
		await git(project.rootPath, [
			"show-ref",
			"--verify",
			`refs/heads/${branch}`,
		]);
		return true;
	} catch {
		return false;
	}
}

export async function uniqueBranch(
	project: Project,
	category: ChangeCategory,
	slug: string,
) {
	const worktrees = await listWorktrees();
	const existingBranches = new Set(
		worktrees.filter((w) => w.projectId === project.id).map((w) => w.branch),
	);
	let branch = `${category}/${slug}`;
	let suffix = 2;
	while (existingBranches.has(branch) || (await branchExists(project, branch)))
		branch = `${category}/${slug}-${suffix++}`;
	return branch;
}

export async function ensureTaskWorktree(
	project: Project,
	task: Pick<Task, "title" | "body" | "worktreeId">,
): Promise<Worktree> {
	if (task.worktreeId) {
		const worktree = (await listWorktrees()).find(
			(w) => w.id === task.worktreeId,
		);
		if (!worktree) throw new Error("Task worktree not found");
		if (worktree.projectId !== project.id)
			throw new Error("Task worktree belongs to another project");
		return worktree;
	}
	return withQueuedLock(`worktree-create:${project.id}`, async () => {
		const category = classifyTaskChange(task);
		const slug = slugifyTask(task);
		let lastError: unknown;
		const root = await worktreeRoot(project.rootPath);
		for (let attempt = 0; attempt < 5; attempt++) {
			const branch = await uniqueBranch(project, category, slug);
			const path = worktreePathForBranch(branch, root);
			try {
				await mkdir(dirname(path), { recursive: true });
				await git(project.rootPath, ["worktree", "add", "-b", branch, path]);
				return await addWorktree(project.id, path);
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError instanceof Error
			? lastError
			: new Error("Failed to create task worktree");
	});
}

export const worktreeAgent = {
	name: "Worktree",
	prompt: worktreePrompt,
	workspaceRoot: SANDBOX_WORKSPACE_ROOT,
	ensureTaskWorktree,
};
