import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

	it("exposes host global skills at the session cwd without writing into the worktree", async () => {
		const root = await tempDir();
		const worktree = join(root, "feat", "foo");
		const globalSkills = join(await tempDir(), "skills");
		await mkdir(worktree, { recursive: true });
		await mkdir(join(globalSkills, "demo"), { recursive: true });
		await writeFile(
			join(globalSkills, "demo", "SKILL.md"),
			"---\nname: demo\ndescription: Demo skill\n---\n\nUse demo.\n",
		);

		const env = await bashFactoryToSessionEnv(
			await createLocalWorktreeSandbox({
				workspaceRoot: root,
				cwd: worktree,
				globalSkillsDir: globalSkills,
			}),
		);

		expect(await env.readdir(".agents/skills")).toEqual(["demo"]);
		expect(await env.readFile(".agents/skills/demo/SKILL.md")).toContain(
			"name: demo",
		);
		await expect(
			env.writeFile(".agents/skills/demo/SKILL.md", "changed"),
		).rejects.toThrow();
		expect(
			await readFile(join(globalSkills, "demo", "SKILL.md"), "utf8"),
		).toContain("Use demo.");
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

	it("runs selected commands from the host PATH", async () => {
		const root = await tempDir();
		const binDir = join(root, "bin");
		await mkdir(binDir, { recursive: true });
		for (const name of ["tea", "make", "gh"]) {
			const bin = join(binDir, name);
			await writeFile(bin, `#!/bin/sh\nprintf '${name}:%s\\n' \"$1\"\n`);
			await chmod(bin, 0o755);
		}
		const previousPath = process.env.PATH;
		process.env.PATH = `${binDir}:${previousPath ?? ""}`;
		try {
			const env = await bashFactoryToSessionEnv(
				await createLocalWorktreeSandbox({ workspaceRoot: root, cwd: root }),
			);

			for (const name of ["tea", "make", "gh"]) {
				const result = await env.exec(`${name} ok`);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toBe(`${name}:ok\n`);
			}
		} finally {
			process.env.PATH = previousPath;
		}
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
