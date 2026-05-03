import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashFactoryToSessionEnv } from "@flue/sdk/internal";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalWorktreeSandbox } from "./localWorktreeSandbox";

const temps: string[] = [];

async function tempDir() {
	const path = await mkdtemp(join(tmpdir(), "aware-flue-"));
	temps.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(
		temps.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("local worktree sandbox", () => {
	it("mounts workspace root at /workspace and scopes cwd to worktree", async () => {
		const root = await tempDir();
		const worktree = join(root, "feat", "foo");
		await mkdir(worktree, { recursive: true });

		const env = await bashFactoryToSessionEnv(
			await createLocalWorktreeSandbox({ workspaceRoot: root, cwd: worktree }),
		);
		await env.writeFile("note.txt", "ok");

		expect(env.cwd).toBe("/workspace/feat/foo");
		expect(await readFile(join(worktree, "note.txt"), "utf8")).toBe("ok");
	});
});
