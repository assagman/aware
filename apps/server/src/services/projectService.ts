import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { Project, Worktree } from "@aware/shared";
import { db } from "../db/client";
import {
	currentBranch,
	isBareRepository,
	isInsideWorkTree,
	repoRoot,
	worktreePaths,
	worktreeRoot,
} from "./gitService";
import { archiveTasksForWorktree } from "./taskService";
import { assertHostWorkspacePath } from "./workspaceConvention";

const now = () => new Date().toISOString();

export async function addProject(path: string): Promise<Project> {
	const gitRoot = await repoRoot(path);
	const rootPath = await assertHostWorkspacePath(
		gitRoot,
		await worktreeRoot(gitRoot),
	);
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

async function listedExistingWorktreePaths(project: Project) {
	const root = await worktreeRoot(project.rootPath);
	const paths = new Set<string>();
	if (await isInsideWorkTree(project.rootPath).catch(() => false))
		paths.add(await assertHostWorkspacePath(project.rootPath, root));
	for (const path of await worktreePaths(project.rootPath)) {
		try {
			await lstat(path);
			if (!(await isInsideWorkTree(path))) continue;
			paths.add(await assertHostWorkspacePath(path, root));
		} catch {
			// Ignore prunable/missing/non-workspace worktrees; active state must only
			// include valid paths reported by `git worktree list`.
		}
	}
	return paths;
}

async function syncProjectWorktrees(project: Project) {
	const paths = await listedExistingWorktreePaths(project);
	for (const worktree of await listStoredWorktrees()) {
		if (worktree.projectId === project.id && !paths.has(worktree.path) && !worktree.deletedAt) {
			const deletedAt = now();
			await archiveTasksForWorktree(worktree.id, deletedAt);
			await db.update<Worktree>("worktrees", worktree.id, {
				deletedAt,
				updatedAt: deletedAt,
			});
		}
	}
	for (const path of paths) await upsertListedWorktree(project, path);
}

async function upsertListedWorktree(project: Project, path: string): Promise<Worktree> {
	const branch = await currentBranch(path).catch(() => "");
	const existing = (await listStoredWorktrees()).find((w) => w.path === path);
	if (existing) {
		if (existing.projectId === project.id && existing.branch === branch && !existing.deletedAt)
			return existing;
		const updated: Worktree = {
			...existing,
			projectId: project.id,
			branch,
			updatedAt: now(),
		};
		delete updated.deletedAt;
		return db.insert("worktrees", updated);
	}
	return db.insert("worktrees", {
		id: randomUUID(),
		projectId: project.id,
		path,
		branch,
		createdAt: now(),
		updatedAt: now(),
	});
}

export async function listProjects() {
	return db.list<Project>("projects");
}

export async function addWorktree(
	projectId: string,
	path: string,
): Promise<Worktree> {
	const project = (await listProjects()).find((p) => p.id === projectId);
	if (!project) throw new Error("Project not found");
	const real = await assertHostWorkspacePath(
		path,
		await worktreeRoot(project.rootPath),
	);
	if (!(await listedExistingWorktreePaths(project)).has(real))
		throw new Error("Worktree not listed by git worktree list");
	const branch = await currentBranch(real);
	const existing = (await listStoredWorktrees()).find((w) => w.path === real);
	if (existing) {
		if (existing.projectId === projectId && existing.branch === branch && !existing.deletedAt)
			return existing;
		const updated: Worktree = {
			...existing,
			projectId,
			branch,
			updatedAt: now(),
		};
		delete updated.deletedAt;
		return db.insert("worktrees", updated);
	}
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

export async function listStoredWorktrees() {
	return db.list<Worktree>("worktrees");
}

let listWorktreesInFlight: Promise<Worktree[]> | null = null;

export async function listWorktrees() {
	if (listWorktreesInFlight) return listWorktreesInFlight;
	listWorktreesInFlight = doListWorktrees().finally(() => {
		listWorktreesInFlight = null;
	});
	return listWorktreesInFlight;
}

async function doListWorktrees() {
	for (const project of await listProjects())
		await syncProjectWorktrees(project).catch(() => undefined);
	const rows = await listStoredWorktrees();
	const visible: Worktree[] = [];
	for (const worktree of rows) {
		if (worktree.deletedAt) continue;
		if (!(await isInsideWorkTree(worktree.path).catch(() => false))) continue;
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
