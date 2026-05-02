import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { assertAllowedWorktree } from "./projectService";

const exec = promisify(execFile);
const ignoredTopDirs = new Set([
	"node_modules",
	"dist",
	"build",
	".next",
	"coverage",
]);

function safeRel(path: string) {
	if (path.includes("..") || path.startsWith("/"))
		throw new Error("Unsafe path");
	return path;
}

async function safePath(root: string, rel = "") {
	const targetPath = join(root, safeRel(rel));
	const exists = await lstat(targetPath)
		.then(() => true)
		.catch(() => false);
	if (!exists) {
		const relPath = relative(root, targetPath);
		if (relPath.startsWith("..") || relPath === "")
			throw new Error("Path escapes worktree");
		return targetPath;
	}
	const target = await realpath(targetPath);
	const relPath = relative(root, target);
	if (relPath.startsWith("..")) throw new Error("Path escapes worktree");
	return target;
}

export async function listTree(
	worktreeId: string,
	dir = "",
): Promise<string[]> {
	const worktree = await assertAllowedWorktree(worktreeId);
	const root = await realpath(worktree.path);
	await safePath(root, dir);
	const { stdout } = await exec(
		"git",
		["ls-files", "-co", "--exclude-standard"],
		{
			cwd: root,
		},
	);
	return stdout
		.split("\n")
		.filter(Boolean)
		.filter((p) => !ignoredTopDirs.has(p.split("/")[0] ?? ""))
		.filter((p) => (dir ? p.startsWith(`${dir}/`) : true))
		.sort();
}

export async function readProjectFile(worktreeId: string, path: string) {
	const worktree = await assertAllowedWorktree(worktreeId);
	const root = await realpath(worktree.path);
	return readFile(await safePath(root, path), "utf8");
}
