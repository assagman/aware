import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Project, Worktree } from "@agent-ide/shared";
import { db } from "../db/client";
import { currentBranch, repoRoot } from "./gitService";

const now = () => new Date().toISOString();

export async function addProject(path: string): Promise<Project> {
	const rootPath = await realpath(await repoRoot(path));
	const existing = (await listProjects()).find((p) => p.rootPath === rootPath);
	if (existing) return existing;
	const row: Project = {
		id: randomUUID(),
		name: rootPath.split("/").at(-1) || rootPath,
		rootPath,
		createdAt: now(),
		updatedAt: now(),
	};
	return db.insert("projects", row);
}

export async function listProjects() {
	return db.list<Project>("projects");
}

export async function addWorktree(
	projectId: string,
	path: string,
): Promise<Worktree> {
	const real = await realpath(path);
	const existing = (await listWorktrees()).find((w) => w.path === real);
	if (existing) return existing;
	const branch = await currentBranch(real);
	const row: Worktree = {
		id: randomUUID(),
		projectId,
		path: real,
		branch,
		createdAt: now(),
		updatedAt: now(),
	};
	return db.insert("worktrees", row);
}

export async function listWorktrees() {
	return db.list<Worktree>("worktrees");
}

export async function assertAllowedWorktree(worktreeId: string) {
	const worktree = (await listWorktrees()).find((w) => w.id === worktreeId);
	if (!worktree) throw new Error("Worktree not allowed");
	return worktree;
}
