import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Project, ProjectSetupArtifact, Task, Worktree } from "@aware/shared";
import { db } from "../db/client";
import { worktreePrompt } from "../flue/agents/worktree";
import { isDefaultBranch } from "./defaultBranchGuard";
import { git, worktreeRoot } from "./gitService";
import { addWorktree, listWorktrees } from "./projectService";
import {
	SANDBOX_WORKSPACE_ROOT,
	worktreePathForBranch,
} from "./workspaceConvention";
import { withQueuedLock } from "./worktreeLock";
import {
	type ChangeCategory,
	classifyTaskChange,
	slugifyTask,
} from "./worktreeNaming";

const exec = promisify(execFile);
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const PROJECT_SETUP_FILES = [
	"README.md",
	"DEVELOPMENT.md",
	"CONTRIBUTING.md",
	"AGENTS.md",
	"package.json",
	"pnpm-lock.yaml",
	"bun.lock",
	"bun.lockb",
	"yarn.lock",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"uv.lock",
	"pyproject.toml",
	"requirements.txt",
	"poetry.lock",
	"Pipfile",
	"Gemfile",
	"Cargo.toml",
	"go.mod",
	"composer.json",
	"mix.exs",
	"Makefile",
	"justfile",
];

export type ProjectInstallCommand = {
	command: string;
	args: string[];
	reason: string;
};

async function fileExists(path: string) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function readTextIfExists(path: string) {
	try {
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}

async function readTextFile(path: string) {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

async function packageManagerFromPackageJson(path: string) {
	try {
		const json = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as {
			packageManager?: unknown;
		};
		return typeof json.packageManager === "string" ? json.packageManager : "";
	} catch {
		return "";
	}
}

async function packageScripts(path: string) {
	try {
		const json = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as {
			scripts?: unknown;
		};
		return json.scripts && typeof json.scripts === "object"
			? Object.keys(json.scripts)
			: [];
	} catch {
		return [];
	}
}

function setupScriptCommand(
	packageManager: string,
	scripts: string[],
): ProjectInstallCommand | undefined {
	const script = ["setup", "bootstrap", "install:deps"].find((name) =>
		scripts.includes(name),
	);
	if (!script) return undefined;
	const command = packageManager.startsWith("pnpm@")
		? "pnpm"
		: packageManager.startsWith("yarn@")
			? "yarn"
			: packageManager.startsWith("bun@")
				? "bun"
				: "npm";
	return { command, args: ["run", script], reason: `package ${script} script` };
}

function commandKey(command: ProjectInstallCommand) {
	return [command.command, ...command.args].join("\0");
}

function uniqueCommands(commands: ProjectInstallCommand[]) {
	const seen = new Set<string>();
	return commands.filter((command) => {
		const key = commandKey(command);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function parseDocumentedSetupCommands(text: string): ProjectInstallCommand[] {
	const commands: ProjectInstallCommand[] = [];
	const patterns: Array<[RegExp, string]> = [
		[/\b(pnpm install)\b/, "documented pnpm install"],
		[/\b(npm install)\b/, "documented npm install"],
		[/\b(yarn install)\b/, "documented yarn install"],
		[/\b(bun install)\b/, "documented bun install"],
		[/\b(uv sync)\b/, "documented uv sync"],
		[/\b(poetry install)\b/, "documented Poetry install"],
		[/\b(pipenv install)\b/, "documented Pipenv install"],
		[/\b(python3? -m pip install -r requirements\.txt)\b/, "documented pip requirements install"],
		[/\b(pip install -r requirements\.txt)\b/, "documented pip requirements install"],
		[/\b(bundle install)\b/, "documented Bundler install"],
		[/\b(cargo fetch)\b/, "documented Cargo fetch"],
		[/\b(go mod download)\b/, "documented Go modules download"],
		[/\b(composer install)\b/, "documented Composer install"],
		[/\b(mix deps\.get)\b/, "documented Mix deps install"],
		[/\b(make (?:setup|bootstrap|install))\b/, "documented Make setup"],
		[/\b(just (?:setup|bootstrap|install))\b/, "documented Just setup"],
	];
	for (const [pattern, reason] of patterns) {
		const match = text.match(pattern)?.[1];
		if (!match) continue;
		const [command = "", ...args] = match.split(/\s+/);
		commands.push({ command, args, reason });
	}
	return uniqueCommands(commands);
}

function jsInstallCommand(
	packageManager: string,
	files: Set<string>,
): ProjectInstallCommand | undefined {
	if (
		packageManager.startsWith("bun@") ||
		files.has("bun.lock") ||
		files.has("bun.lockb")
	)
		return { command: "bun", args: ["install"], reason: "bun project" };
	if (packageManager.startsWith("pnpm@") || files.has("pnpm-lock.yaml"))
		return { command: "pnpm", args: ["install"], reason: "pnpm project" };
	if (packageManager.startsWith("yarn@") || files.has("yarn.lock"))
		return { command: "yarn", args: ["install"], reason: "yarn project" };
	if (
		packageManager.startsWith("npm@") ||
		files.has("package-lock.json") ||
		files.has("npm-shrinkwrap.json")
	)
		return { command: "npm", args: ["install"], reason: "npm project" };
	if (files.has("package.json"))
		return { command: "npm", args: ["install"], reason: "package.json project" };
	return undefined;
}

async function projectSetupSignature(path: string) {
	const parts = await Promise.all(
		PROJECT_SETUP_FILES.map(async (file) => {
			const contents = await readTextFile(join(path, file));
			if (contents === undefined) return "";
			const hash = createHash("sha256").update(contents).digest("hex");
			return `${file}:${hash}`;
		}),
	);
	return parts.filter(Boolean).join("|");
}

export async function detectProjectInstallCommands(
	path: string,
): Promise<ProjectInstallCommand[]> {
	const files = new Set(
		(
			await Promise.all(
				PROJECT_SETUP_FILES.map(async (file) =>
					(await fileExists(join(path, file))) ? file : "",
				),
			)
		).filter(Boolean),
	);
	const packageManager = await packageManagerFromPackageJson(path);
	const commands: ProjectInstallCommand[] = [];
	const docs = await Promise.all(
		["README.md", "DEVELOPMENT.md", "CONTRIBUTING.md", "AGENTS.md"].map(
			(file) => readTextIfExists(join(path, file)),
		),
	);
	commands.push(...parseDocumentedSetupCommands(docs.join("\n")));
	const jsCommand = jsInstallCommand(packageManager, files);
	if (jsCommand) commands.push(jsCommand);
	const scriptCommand = setupScriptCommand(
		packageManager,
		await packageScripts(path),
	);
	if (scriptCommand) commands.push(scriptCommand);
	if (files.has("uv.lock") || files.has("pyproject.toml"))
		commands.push({
			command: "uv",
			args: ["sync"],
			reason: "uv Python project",
		});
	else if (files.has("poetry.lock"))
		commands.push({ command: "poetry", args: ["install"], reason: "Poetry project" });
	else if (files.has("Pipfile"))
		commands.push({ command: "pipenv", args: ["install"], reason: "Pipenv project" });
	else if (files.has("requirements.txt"))
		commands.push({
			command: "python3",
			args: ["-m", "pip", "install", "-r", "requirements.txt"],
			reason: "Python requirements",
		});
	if (files.has("Gemfile"))
		commands.push({ command: "bundle", args: ["install"], reason: "Bundler project" });
	if (files.has("Cargo.toml"))
		commands.push({ command: "cargo", args: ["fetch"], reason: "Cargo project" });
	if (files.has("go.mod"))
		commands.push({ command: "go", args: ["mod", "download"], reason: "Go modules" });
	if (files.has("composer.json"))
		commands.push({ command: "composer", args: ["install"], reason: "Composer project" });
	if (files.has("mix.exs"))
		commands.push({ command: "mix", args: ["deps.get"], reason: "Mix project" });
	return uniqueCommands(commands);
}

async function cachedProjectSetup(project: Project, path: string) {
	const signature = await projectSetupSignature(path);
	const artifacts = await db.list<ProjectSetupArtifact>("projectSetupArtifacts");
	const cached = artifacts.find(
		(artifact) =>
			artifact.projectId === project.id && artifact.signature === signature,
	);
	if (cached) return cached.commands;
	const commands = await detectProjectInstallCommands(path);
	const timestamp = new Date().toISOString();
	const artifactKey = createHash("sha256").update(signature).digest("hex");
	await db.insert<ProjectSetupArtifact>("projectSetupArtifacts", {
		id: `${project.id}:${artifactKey}`,
		projectId: project.id,
		signature,
		commands,
		createdAt: timestamp,
		updatedAt: timestamp,
	});
	return commands;
}

export async function installProjectDependencies(path: string, project?: Project) {
	const commands = project
		? await cachedProjectSetup(project, path)
		: await detectProjectInstallCommands(path);
	for (const { command, args } of commands) {
		await exec(command, args, { cwd: path, timeout: INSTALL_TIMEOUT_MS });
	}
	return commands;
}

async function branchExists(project: Project, branch: string) {
	try {
		await git(project.rootPath, [
			"show-ref",
			"--verify",
			`refs/heads/${branch}`,
		]);
		return true;
	} catch {
		return false;
	}
}

export async function uniqueBranch(
	project: Project,
	category: ChangeCategory,
	slug: string,
) {
	const worktrees = await listWorktrees();
	const existingBranches = new Set(
		worktrees.filter((w) => w.projectId === project.id).map((w) => w.branch),
	);
	let branch = `${category}/${slug}`;
	let suffix = 2;
	while (existingBranches.has(branch) || (await branchExists(project, branch)))
		branch = `${category}/${slug}-${suffix++}`;
	return branch;
}

async function createTaskWorktree(
	project: Project,
	task: Pick<Task, "title" | "body">,
): Promise<Worktree> {
	return withQueuedLock(`worktree-create:${project.id}`, async () => {
		const category = classifyTaskChange(task);
		const slug = slugifyTask(task);
		let lastError: unknown;
		const root = await worktreeRoot(project.rootPath);
		for (let attempt = 0; attempt < 5; attempt++) {
			const branch = await uniqueBranch(project, category, slug);
			const path = worktreePathForBranch(branch, root);
			try {
				await mkdir(dirname(path), { recursive: true });
				await git(project.rootPath, ["worktree", "add", "-b", branch, path]);
			} catch (error) {
				lastError = error;
				continue;
			}
			await installProjectDependencies(path, project);
			return await addWorktree(project.id, path);
		}
		throw lastError instanceof Error
			? lastError
			: new Error("Failed to create task worktree");
	});
}

export async function ensureTaskWorktree(
	project: Project,
	task: Pick<Task, "title" | "body" | "worktreeId">,
): Promise<Worktree> {
	if (task.worktreeId) {
		const worktree = (await listWorktrees()).find(
			(w) => w.id === task.worktreeId,
		);
		if (!worktree) throw new Error("Task worktree not found");
		if (worktree.projectId !== project.id)
			throw new Error("Task worktree belongs to another project");
		if (!isDefaultBranch(worktree)) return worktree;
	}
	return createTaskWorktree(project, task);
}

export async function ensureMutableWorktree(
	project: Project,
	worktree: Worktree,
	task: Pick<Task, "title" | "body">,
): Promise<Worktree> {
	if (worktree.projectId !== project.id)
		throw new Error("Worktree belongs to another project");
	return isDefaultBranch(worktree)
		? createTaskWorktree(project, task)
		: worktree;
}

export const worktreeAgent = {
	name: "Worktree",
	prompt: worktreePrompt,
	workspaceRoot: SANDBOX_WORKSPACE_ROOT,
	ensureTaskWorktree,
};
