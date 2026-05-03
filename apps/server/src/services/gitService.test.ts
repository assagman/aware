import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, worktreeRoot } from "./gitService";

const temps: string[] = [];

async function tempDir() {
	const path = await mkdtemp(join(tmpdir(), "aware-git-"));
	temps.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(
		temps.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("git service", () => {
	it("uses bare repository root as worktree root", async () => {
		const root = await tempDir();
		const bare = join(root, "repo");
		const seed = join(root, "seed");
		const main = join(root, "main");
		await git(root, ["init", "--bare", bare]);
		await mkdir(seed);
		await git(seed, ["init", "-b", "main"]);
		await writeFile(join(seed, "README.md"), "# test\n");
		await git(seed, ["add", "README.md"]);
		await git(seed, [
			"-c",
			"user.name=test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-m",
			"init",
		]);
		await git(seed, ["push", bare, "main"]);
		await git(bare, ["worktree", "add", main, "main"]);

		expect(await worktreeRoot(main)).toBe(await realpath(bare));
	});

	it("uses parent workspace root for nested non-bare worktrees", async () => {
		const root = await tempDir();
		const main = join(root, "main");
		const nestedWorktree = join(root, "feat", "foo");
		await mkdir(main);
		await git(main, ["init", "-b", "main"]);
		await writeFile(join(main, "README.md"), "# test\n");
		await git(main, ["add", "README.md"]);
		await git(main, [
			"-c",
			"user.name=test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-m",
			"init",
		]);
		await mkdir(join(root, "feat"));
		await git(main, ["worktree", "add", "-b", "feat/foo", nestedWorktree]);

		expect(await worktreeRoot(main)).toBe(await realpath(root));
		expect(await worktreeRoot(nestedWorktree)).toBe(await realpath(root));
	});
});
