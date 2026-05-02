import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(cwd: string, args: string[]) {
	const { stdout, stderr } = await exec("git", args, { cwd });
	return { stdout, stderr };
}

export async function repoRoot(path: string) {
	try {
		const { stdout } = await git(path, ["rev-parse", "--show-toplevel"]);
		return stdout.trim();
	} catch {
		// Accept git dirs / bare-ish project roots too. Worktree is added separately.
		await git(path, ["rev-parse", "--git-dir"]);
		return path;
	}
}

export async function currentBranch(path: string) {
	const { stdout } = await git(path, ["branch", "--show-current"]);
	return stdout.trim();
}

export async function statusShort(path: string) {
	const { stdout } = await git(path, ["status", "--short"]);
	return stdout;
}

export async function diff(
	path: string,
	mode: "unstaged" | "staged" | "base" = "unstaged",
	base = "HEAD",
) {
	if (mode === "staged") return (await git(path, ["diff", "--staged"])).stdout;
	if (mode === "base")
		return (await git(path, ["diff", `${base}...HEAD`])).stdout;
	return (await git(path, ["diff"])).stdout;
}
