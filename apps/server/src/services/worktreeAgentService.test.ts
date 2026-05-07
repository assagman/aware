import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	HOST_WORKSPACE_ROOT,
	hostToSandboxPath,
	isHostWorkspacePath,
	isSandboxWorkspacePath,
	SANDBOX_WORKSPACE_ROOT,
	sandboxToHostPath,
	worktreePathForBranch,
} from "./workspaceConvention";
import { detectProjectInstallCommands } from "./worktreeAgentService";
import { classifyTaskChange, slugifyTask } from "./worktreeNaming";

async function tempProject(files: Record<string, string>) {
	const path = await mkdtemp(join(tmpdir(), "aware-install-detect-"));
	await Promise.all(
		Object.entries(files).map(([file, contents]) =>
			writeFile(join(path, file), contents),
		),
	);
	return path;
}

describe("Worktree agent", () => {
	it("classifies dedicated change categories", () => {
		expect(classifyTaskChange({ title: "Fix auth crash", body: "" })).toBe(
			"fix",
		);
		expect(classifyTaskChange({ title: "Add API route", body: "" })).toBe(
			"api",
		);
		expect(
			classifyTaskChange({ title: "Improve screen reader labels", body: "" }),
		).toBe("ux");
		expect(
			classifyTaskChange({ title: "Document install flow", body: "" }),
		).toBe("docs");
		expect(classifyTaskChange({ title: "Add dashboard", body: "" })).toBe(
			"feat",
		);
	});

	it("preserves explicit categories without duplicating slug prefix", () => {
		const task = { title: "experiment: try new agent UI", body: "" };
		expect(classifyTaskChange(task)).toBe("experiment");
		expect(slugifyTask(task)).toBe("try-new-agent-ui");
	});

	it("creates minimal max-four-word slug", () => {
		expect(
			slugifyTask({
				title: "Fix worktree behavior when starting a new task",
				body: "",
			}),
		).toBe("behavior-when-starting-new");
	});

	it("detects JS project install command from package manager metadata", async () => {
		const path = await tempProject({
			"package.json": JSON.stringify({ packageManager: "pnpm@9.15.0" }),
		});
		await expect(detectProjectInstallCommands(path)).resolves.toEqual([
			{ command: "pnpm", args: ["install"], reason: "pnpm project" },
		]);
	});

	it("detects documented setup commands beyond JS/TS", async () => {
		const path = await tempProject({
			"DEVELOPMENT.md": "## Setup\n```sh\nmake setup\nbundle install\n```\n",
		});
		await expect(detectProjectInstallCommands(path)).resolves.toEqual([
			{ command: "bundle", args: ["install"], reason: "documented Bundler install" },
			{ command: "make", args: ["setup"], reason: "documented Make setup" },
		]);
	});

	it("detects Python sync/install commands", async () => {
		await expect(
			detectProjectInstallCommands(await tempProject({ "uv.lock": "" })),
		).resolves.toEqual([
			{ command: "uv", args: ["sync"], reason: "uv Python project" },
		]);
		await expect(
			detectProjectInstallCommands(
				await tempProject({ "requirements.txt": "pytest\n" }),
			),
		).resolves.toEqual([
			{
				command: "python3",
				args: ["-m", "pip", "install", "-r", "requirements.txt"],
				reason: "Python requirements",
			},
		]);
	});

	it("maps branches to host paths and sandbox paths separately", () => {
		const hostPath = `${HOST_WORKSPACE_ROOT}/fix/worktree-behavior`;
		expect(worktreePathForBranch("fix/worktree-behavior")).toBe(hostPath);
		expect(isHostWorkspacePath(hostPath)).toBe(true);
		expect(isHostWorkspacePath("/tmp/main")).toBe(false);
		expect(isSandboxWorkspacePath("/workspace/main")).toBe(true);
		expect(hostToSandboxPath(hostPath)).toBe(
			`${SANDBOX_WORKSPACE_ROOT}/fix/worktree-behavior`,
		);
		expect(sandboxToHostPath("/workspace/fix/worktree-behavior")).toBe(
			hostPath,
		);
	});
});
