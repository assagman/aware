import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function git(cwd: string, args: string[]) {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const { stdout, stderr } = await exec("git", args, { cwd });
			return { stdout, stderr };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt < 2 && (code === "EBADF" || code === "EMFILE")) {
				await wait(50 * (attempt + 1));
				continue;
			}
			throw error;
		}
	}
	throw new Error("git spawn failed");
}

async function gitAllowExitOne(cwd: string, args: string[]) {
	try {
		return await git(cwd, args);
	} catch (error) {
		const exitCode = (error as { code?: unknown }).code;
		if (exitCode === 1) {
			const { stdout = "", stderr = "" } = error as {
				stdout?: string;
				stderr?: string;
			};
			return { stdout, stderr };
		}
		throw error;
	}
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

export async function isInsideWorkTree(path: string) {
	try {
		const { stdout } = await git(path, ["rev-parse", "--is-inside-work-tree"]);
		return stdout.trim() === "true";
	} catch {
		return false;
	}
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

async function untrackedDiff(path: string) {
	const { stdout } = await git(path, [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	]);
	const files = stdout.split("\0").filter(Boolean);
	const patches = await Promise.all(
		files.map(async (file) =>
			(await gitAllowExitOne(path, ["diff", "--no-index", "--", "/dev/null", file]))
				.stdout,
		),
	);
	return patches.filter(Boolean).join("\n");
}

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
	return [(await git(path, ["diff"])).stdout, await untrackedDiff(path)]
		.filter(Boolean)
		.join("\n");
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
