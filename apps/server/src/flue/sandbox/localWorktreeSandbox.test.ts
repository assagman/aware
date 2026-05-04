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

	it("passes heredoc stdin to host python commands", async () => {
		const root = await tempDir();
		const env = await bashFactoryToSessionEnv(
			await createLocalWorktreeSandbox({ workspaceRoot: root, cwd: root }),
		);

		const result = await env.exec(`python - <<'PY' > out.txt
print("ok")
PY`);

		expect(result.exitCode).toBe(0);
		expect(await readFile(join(root, "out.txt"), "utf8")).toBe("ok\n");
	});

	it("kills host commands after hard timeout", async () => {
		const root = await tempDir();
		process.env.AWARE_MAX_TOOL_TIMEOUT_MS = "100";
		try {
			const env = await bashFactoryToSessionEnv(
				await createLocalWorktreeSandbox({ workspaceRoot: root, cwd: root }),
			);

			const result = await env.exec(`python - <<'PY'
import time
time.sleep(5)
PY`);

			expect(result.exitCode).toBe(124);
			expect(result.stderr).toContain("Tool command timed out");
		} finally {
			delete process.env.AWARE_MAX_TOOL_TIMEOUT_MS;
		}
	});
});
