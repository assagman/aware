import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
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

export async function isBareRepository(path: string) {
	const { stdout } = await git(path, ["rev-parse", "--is-bare-repository"]);
	return stdout.trim() === "true";
}

export async function worktreePaths(path: string) {
	const { stdout } = await git(path, ["worktree", "list", "--porcelain"]);
	return stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

async function realpathOrResolve(path: string) {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

export async function worktreeRoot(path: string) {
	const { stdout } = await git(path, ["rev-parse", "--git-common-dir"]);
	const commonDir = stdout.trim();
	const absoluteCommonDir = isAbsolute(commonDir)
		? commonDir
		: resolve(path, commonDir);
	if (await isBareRepository(absoluteCommonDir).catch(() => false))
		return realpathOrResolve(absoluteCommonDir);
	const paths = await worktreePaths(path).catch(() => []);
	const primaryWorktree = paths.find(
		(path) => !path.endsWith(" (bare)") && path !== absoluteCommonDir,
	);
	const topLevel = primaryWorktree
		? await repoRoot(primaryWorktree)
		: await repoRoot(path);
	return realpathOrResolve(dirname(topLevel));
}

export async function statusShort(path: string) {
	const { stdout } = await git(path, ["status", "--short"]);
	return stdout;
}

export type DiffMode =
	| "unstaged"
	| "staged"
	| "base"
	| "main"
	| "last"
	| "commit";

export async function diff(
	path: string,
	mode: DiffMode = "unstaged",
	base = "HEAD",
	commit = "HEAD",
) {
	if (mode === "staged") return (await git(path, ["diff", "--staged"])).stdout;
	if (mode === "base")
		return (await git(path, ["diff", `${base}...HEAD`])).stdout;
	if (mode === "main") return (await git(path, ["diff", "main..HEAD"])).stdout;
	if (mode === "last")
		return (await git(path, ["diff", "HEAD~1..HEAD"])).stdout;
	if (mode === "commit")
		return (await git(path, ["diff", `${commit}^..${commit}`])).stdout;
	return (await git(path, ["diff"])).stdout;
}

export type GitCommit = {
	sha: string;
	subject: string;
	author: string;
	date: string;
};

export async function commits(path: string, limit = 50): Promise<GitCommit[]> {
	const { stdout } = await git(path, [
		"log",
		`--max-count=${limit}`,
		"--date=short",
		"--pretty=format:%H%x1f%ad%x1f%an%x1f%s",
	]);
	return stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [sha = "", date = "", author = "", subject = ""] =
				line.split("\x1f");
			return { sha, date, author, subject };
		});
}
