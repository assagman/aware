import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export const WORKSPACE_ROOT = "/workspace";

export function isWorkspacePath(path: string) {
	const resolved = resolve(path);
	return (
		resolved === WORKSPACE_ROOT || resolved.startsWith(`${WORKSPACE_ROOT}/`)
	);
}

export async function assertWorkspacePath(path: string) {
	const resolved = resolve(path);
	if (isWorkspacePath(resolved)) return resolved;
	const real = await realpath(path);
	if (!isWorkspacePath(real))
		throw new Error(`Worktrees must live under ${WORKSPACE_ROOT}`);
	return real;
}

export function worktreePathForBranch(branch: string) {
	return `${WORKSPACE_ROOT}/${branch}`;
}
