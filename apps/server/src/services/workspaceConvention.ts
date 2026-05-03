import { realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export const SANDBOX_WORKSPACE_ROOT = "/workspace";
export const HOST_WORKSPACE_ROOT = resolve(
	process.env.AWARE_WORKSPACE_ROOT ?? dirname(process.cwd()),
);

export function isHostWorkspacePath(path: string) {
	const resolved = resolve(path);
	return (
		resolved === HOST_WORKSPACE_ROOT ||
		resolved.startsWith(`${HOST_WORKSPACE_ROOT}/`)
	);
}

export function isSandboxWorkspacePath(path: string) {
	const resolved = resolve(path);
	return (
		resolved === SANDBOX_WORKSPACE_ROOT ||
		resolved.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`)
	);
}

export async function assertHostWorkspacePath(path: string) {
	const resolved = resolve(path);
	if (isHostWorkspacePath(resolved)) return resolved;
	const real = await realpath(path);
	if (!isHostWorkspacePath(real))
		throw new Error(`Worktrees must live under ${HOST_WORKSPACE_ROOT}`);
	return real;
}

export function hostToSandboxPath(path: string) {
	const resolved = resolve(path);
	if (!isHostWorkspacePath(resolved))
		throw new Error(`Path must live under ${HOST_WORKSPACE_ROOT}`);
	const rel = relative(HOST_WORKSPACE_ROOT, resolved);
	return rel ? `${SANDBOX_WORKSPACE_ROOT}/${rel}` : SANDBOX_WORKSPACE_ROOT;
}

export function sandboxToHostPath(path: string) {
	const resolved = resolve(path);
	if (!isSandboxWorkspacePath(resolved))
		throw new Error(`Path must live under ${SANDBOX_WORKSPACE_ROOT}`);
	const rel = relative(SANDBOX_WORKSPACE_ROOT, resolved);
	return rel ? resolve(HOST_WORKSPACE_ROOT, rel) : HOST_WORKSPACE_ROOT;
}

export function worktreePathForBranch(branch: string) {
	return `${HOST_WORKSPACE_ROOT}/${branch}`;
}
