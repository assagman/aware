import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const SANDBOX_WORKSPACE_ROOT = "/workspace";

function gitOutput(args: string[]) {
	return execFileSync("git", args, {
		cwd: process.cwd(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

function defaultHostWorkspaceRoot() {
	try {
		const commonDir = gitOutput(["rev-parse", "--git-common-dir"]);
		const absoluteCommonDir = isAbsolute(commonDir)
			? commonDir
			: resolve(process.cwd(), commonDir);
		const isBare =
			execFileSync("git", ["rev-parse", "--is-bare-repository"], {
				cwd: absoluteCommonDir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() === "true";
		if (isBare) return absoluteCommonDir;
		const topLevel = gitOutput(["rev-parse", "--show-toplevel"]);
		return dirname(topLevel);
	} catch {
		return dirname(process.cwd());
	}
}

export const HOST_WORKSPACE_ROOT = resolve(
	process.env.AWARE_WORKSPACE_ROOT ?? defaultHostWorkspaceRoot(),
);

export function isHostWorkspacePath(path: string, root = HOST_WORKSPACE_ROOT) {
	const resolved = resolve(path);
	const workspaceRoot = resolve(root);
	return resolved === workspaceRoot || resolved.startsWith(`${workspaceRoot}/`);
}

export function isSandboxWorkspacePath(path: string) {
	const resolved = resolve(path);
	return (
		resolved === SANDBOX_WORKSPACE_ROOT ||
		resolved.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`)
	);
}

export async function assertHostWorkspacePath(
	path: string,
	root = HOST_WORKSPACE_ROOT,
) {
	const workspaceRoot = resolve(root);
	const resolved = resolve(path);
	if (isHostWorkspacePath(resolved, workspaceRoot)) return resolved;
	const real = await realpath(path);
	if (!isHostWorkspacePath(real, workspaceRoot))
		throw new Error(`Worktrees must live under ${workspaceRoot}`);
	return real;
}

export function hostToSandboxPath(path: string, root = HOST_WORKSPACE_ROOT) {
	const workspaceRoot = resolve(root);
	const resolved = resolve(path);
	if (!isHostWorkspacePath(resolved, workspaceRoot))
		throw new Error(`Path must live under ${workspaceRoot}`);
	const rel = relative(workspaceRoot, resolved);
	return rel ? `${SANDBOX_WORKSPACE_ROOT}/${rel}` : SANDBOX_WORKSPACE_ROOT;
}

export function sandboxToHostPath(path: string, root = HOST_WORKSPACE_ROOT) {
	const workspaceRoot = resolve(root);
	const resolved = resolve(path);
	if (!isSandboxWorkspacePath(resolved))
		throw new Error(`Path must live under ${SANDBOX_WORKSPACE_ROOT}`);
	const rel = relative(SANDBOX_WORKSPACE_ROOT, resolved);
	return rel ? resolve(workspaceRoot, rel) : workspaceRoot;
}

export function worktreePathForBranch(
	branch: string,
	root = HOST_WORKSPACE_ROOT,
) {
	return `${resolve(root)}/${branch}`;
}
