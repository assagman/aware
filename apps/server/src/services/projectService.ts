import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Project, Worktree } from "@aware/shared";
import { db } from "../db/client";
import {
	currentBranch,
	isBareRepository,
	repoRoot,
	worktreePaths,
} from "./gitService";

const now = () => new Date().toISOString();

export async function addProject(path: string): Promise<Project> {
	const rootPath = await realpath(await repoRoot(path));
	const existing = (await listProjects()).find((p) => p.rootPath === rootPath);
	const project =
		existing ??
		(await db.insert("projects", {
			id: randomUUID(),
			name: rootPath.split("/").at(-1) || rootPath,
			rootPath,
			createdAt: now(),
			updatedAt: now(),
		}));
	await syncProjectWorktrees(project);
	return project;
}

async function syncProjectWorktrees(project: Project) {
	try {
		for (const path of await worktreePaths(project.rootPath))
			await addWorktree(project.id, path);
	} catch {
		// Keep stale entries visible if repo path is temporarily unavailable.
	}
}

export async function listProjects() {
	return db.list<Project>("projects");
}

export async function addWorktree(
	projectId: string,
	path: string,
): Promise<Worktree> {
	const real = await realpath(path);
	const existing = (await listStoredWorktrees()).find((w) => w.path === real);
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

async function listStoredWorktrees() {
	return db.list<Worktree>("worktrees");
}

export async function listWorktrees() {
	for (const project of await listProjects())
		await syncProjectWorktrees(project);
	const rows = await listStoredWorktrees();
	const visible: Worktree[] = [];
	for (const worktree of rows) {
		if (await isBareRepository(worktree.path).catch(() => false)) continue;
		visible.push(worktree);
	}
	return visible;
}

export async function assertAllowedWorktree(worktreeId: string) {
	const worktree = (await listWorktrees()).find((w) => w.id === worktreeId);
	if (!worktree) throw new Error("Worktree not allowed");
	return worktree;
}
