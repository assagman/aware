import { spawn } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	readdirSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import type { BashFactory } from "@flue/sdk/client";
import { bashFactoryToSessionEnv } from "@flue/sdk/internal";
import {
	Bash,
	defineCommand,
	InMemoryFs,
	MountableFs,
	OverlayFs,
	ReadWriteFs,
	type IFileSystem,
} from "just-bash";
import {
	assertHostWorkspacePath,
	HOST_WORKSPACE_ROOT,
	hostToSandboxPath,
	isSandboxWorkspacePath,
	SANDBOX_WORKSPACE_ROOT,
	sandboxToHostPath,
} from "../../services/workspaceConvention";

const MAX_TOOL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024 * 20;

function maxToolTimeoutMs() {
	const override = Number(process.env.AWARE_MAX_TOOL_TIMEOUT_MS);
	return Number.isFinite(override) && override > 0
		? Math.min(override, MAX_TOOL_TIMEOUT_MS)
		: MAX_TOOL_TIMEOUT_MS;
}

function combineAbortSignals(signals: AbortSignal[]) {
	const controller = new AbortController();
	const abort = () => controller.abort();
	for (const signal of signals) {
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	}
	return controller.signal;
}

async function execHostCommand(
	bin: string,
	args: string[],
	options: { cwd: string; stdin: string; signal?: AbortSignal | undefined },
) {
	return await new Promise<{
		stdout: string;
		stderr: string;
		exitCode: number;
	}>((resolveResult) => {
		const timeoutController = new AbortController();
		const timeout = setTimeout(
			() => timeoutController.abort(),
			maxToolTimeoutMs(),
		);
		const child = spawn(bin, args, {
			cwd: options.cwd,
			env: process.env,
			signal: combineAbortSignals(
				[options.signal, timeoutController.signal].filter(
					Boolean,
				) as AbortSignal[],
			),
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: {
			stdout: string;
			stderr: string;
			exitCode: number;
		}) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolveResult(result);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.length + stderr.length > MAX_TOOL_OUTPUT_BYTES) child.kill();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (stdout.length + stderr.length > MAX_TOOL_OUTPUT_BYTES) child.kill();
		});
		child.on("error", (error) =>
			finish({
				stdout,
				stderr:
					stderr ||
					(timeoutController.signal.aborted
						? `[aware] Tool command timed out after ${maxToolTimeoutMs()}ms.\n`
						: `${error.message}\n`),
				exitCode: timeoutController.signal.aborted ? 124 : 1,
			}),
		);
		child.on("close", (code, signal) =>
			finish({
				stdout,
				stderr:
					stderr ||
					(timeoutController.signal.aborted
						? `[aware] Tool command timed out after ${maxToolTimeoutMs()}ms.\n`
						: signal
							? `[aware] Tool command killed by ${signal}.\n`
							: ""),
				exitCode: timeoutController.signal.aborted ? 124 : (code ?? 1),
			}),
		);
		child.stdin.end(options.stdin);
	});
}

function capBashExecTimeout(bash: Bash) {
	const originalExec = bash.exec.bind(bash);
	bash.exec = (async (command: string, options?: { signal?: AbortSignal }) => {
		const timeoutController = new AbortController();
		const timeout = setTimeout(
			() => timeoutController.abort(),
			maxToolTimeoutMs(),
		);
		try {
			const result = await originalExec(command, {
				...options,
				signal: combineAbortSignals(
					[options?.signal, timeoutController.signal].filter(
						Boolean,
					) as AbortSignal[],
				),
			});
			return timeoutController.signal.aborted
				? {
						...result,
						exitCode: 124,
						stderr: `[aware] Tool command timed out after ${maxToolTimeoutMs()}ms.\n${result.stderr}`,
					}
				: result;
		} finally {
			clearTimeout(timeout);
		}
	}) as Bash["exec"];
	return bash;
}

type WorkspaceSandboxOptions = {
	workspaceRoot: string;
	cwd: string;
	globalSkillsDir?: string;
	blockedGlobalSkillDirs?: string[];
	blockedWorkspaceSkillDirs?: string[];
};

type RoutedFs = {
	fs: IFileSystem;
	path: string;
};

type SkillPath = {
	workspacePath: string;
	globalPath: string;
	skillDir?: string;
	root: boolean;
};

function defaultGlobalSkillsDir() {
	return (
		process.env.AWARE_GLOBAL_SKILLS_DIR ?? join(homedir(), ".agents", "skills")
	);
}

function existingDirectory(path: string) {
	try {
		return existsSync(path) && statSync(path).isDirectory();
	} catch {
		return false;
	}
}

class WorkspaceSkillsFs implements IFileSystem {
	private readonly workspaceFs: IFileSystem;
	private readonly skillsFs?: IFileSystem;
	private readonly blockedGlobalSkillDirs: Set<string>;
	private readonly blockedWorkspaceSkillDirs: Set<string>;

	constructor(options: {
		workspaceRoot: string;
		globalSkillsDir?: string | undefined;
		blockedGlobalSkillDirs?: string[] | undefined;
		blockedWorkspaceSkillDirs?: string[] | undefined;
	}) {
		this.workspaceFs = new ReadWriteFs({ root: options.workspaceRoot });
		this.blockedGlobalSkillDirs = new Set(options.blockedGlobalSkillDirs ?? []);
		this.blockedWorkspaceSkillDirs = new Set(
			options.blockedWorkspaceSkillDirs ?? [],
		);
		const skillsDir = options.globalSkillsDir ?? defaultGlobalSkillsDir();
		if (existingDirectory(skillsDir)) {
			this.skillsFs = new OverlayFs({
				root: skillsDir,
				mountPoint: "/",
				readOnly: true,
			});
		}
	}

	private skillPath(path: string): SkillPath | undefined {
		const normalized = posix.normalize(
			path.startsWith("/") ? path : `/${path}`,
		);
		const marker = "/.agents/skills";
		const markerIndex = normalized.indexOf(marker);
		if (markerIndex < 0) return undefined;
		const rest = normalized.slice(markerIndex + marker.length);
		if (rest && !rest.startsWith("/")) return undefined;
		const skillDir = rest.split("/").filter(Boolean)[0];
		return {
			workspacePath: path,
			globalPath: rest || "/",
			...(skillDir ? { skillDir } : {}),
			root: !skillDir,
		};
	}

	private isBlocked(skillPath: SkillPath, scope: "global" | "workspace") {
		if (!skillPath.skillDir) return false;
		const blocked =
			scope === "global"
				? this.blockedGlobalSkillDirs
				: this.blockedWorkspaceSkillDirs;
		return blocked.has(skillPath.skillDir);
	}

	private async workspaceExists(path: string) {
		try {
			return await this.workspaceFs.exists(path);
		} catch {
			return false;
		}
	}

	private async globalExists(path: string) {
		try {
			return this.skillsFs ? await this.skillsFs.exists(path) : false;
		} catch {
			return false;
		}
	}

	private async readRoute(path: string): Promise<RoutedFs> {
		const skillPath = this.skillPath(path);
		if (skillPath) {
			if (
				!this.isBlocked(skillPath, "workspace") &&
				(await this.workspaceExists(skillPath.workspacePath))
			)
				return { fs: this.workspaceFs, path: skillPath.workspacePath };
			if (
				this.skillsFs &&
				!this.isBlocked(skillPath, "global") &&
				(await this.globalExists(skillPath.globalPath))
			)
				return { fs: this.skillsFs, path: skillPath.globalPath };
		}
		return { fs: this.workspaceFs, path };
	}

	private async writeRoute(path: string): Promise<RoutedFs> {
		const skillPath = this.skillPath(path);
		if (
			skillPath &&
			this.skillsFs &&
			!this.isBlocked(skillPath, "global") &&
			(await this.globalExists(skillPath.globalPath)) &&
			!(await this.workspaceExists(skillPath.workspacePath))
		)
			return { fs: this.skillsFs, path: skillPath.globalPath };
		return { fs: this.workspaceFs, path };
	}

	readFile: IFileSystem["readFile"] = async (path, options) => {
		const routed = await this.readRoute(path);
		return routed.fs.readFile(routed.path, options);
	};
	readFileBuffer: IFileSystem["readFileBuffer"] = async (path) => {
		const routed = await this.readRoute(path);
		return routed.fs.readFileBuffer(routed.path);
	};
	writeFile: IFileSystem["writeFile"] = async (path, content, options) => {
		const routed = await this.writeRoute(path);
		return routed.fs.writeFile(routed.path, content, options);
	};
	appendFile: IFileSystem["appendFile"] = async (path, content, options) => {
		const routed = await this.writeRoute(path);
		return routed.fs.appendFile(routed.path, content, options);
	};
	exists: IFileSystem["exists"] = async (path) => {
		const skillPath = this.skillPath(path);
		if (!skillPath) return this.workspaceFs.exists(path);
		return (
			(!this.isBlocked(skillPath, "workspace") &&
				(await this.workspaceExists(skillPath.workspacePath))) ||
			(!this.isBlocked(skillPath, "global") &&
				(await this.globalExists(skillPath.globalPath)))
		);
	};
	stat: IFileSystem["stat"] = async (path) => {
		const routed = await this.readRoute(path);
		return routed.fs.stat(routed.path);
	};
	lstat: IFileSystem["lstat"] = async (path) => {
		const routed = await this.readRoute(path);
		return routed.fs.lstat(routed.path);
	};
	mkdir: IFileSystem["mkdir"] = async (path, options) => {
		const routed = await this.writeRoute(path);
		return routed.fs.mkdir(routed.path, options);
	};
	readdir: IFileSystem["readdir"] = async (path) => {
		const skillPath = this.skillPath(path);
		if (!skillPath?.root) {
			const routed = await this.readRoute(path);
			return routed.fs.readdir(routed.path);
		}
		const workspaceEntries = await this.workspaceFs
			.readdir(skillPath.workspacePath)
			.catch(() => []);
		const globalEntries = this.skillsFs
			? await this.skillsFs.readdir(skillPath.globalPath).catch(() => [])
			: [];
		return Array.from(
			new Set([
				...workspaceEntries.filter(
					(entry) => !this.blockedWorkspaceSkillDirs.has(entry),
				),
				...globalEntries.filter(
					(entry) => !this.blockedGlobalSkillDirs.has(entry),
				),
			]),
		).sort();
	};
	readdirWithFileTypes(path: string) {
		const skillPath = this.skillPath(path);
		if (!skillPath?.root)
			return this.readRoute(path).then(
				(routed) => routed.fs.readdirWithFileTypes?.(routed.path) ?? [],
			);
		return Promise.all([
			this.workspaceFs
				.readdirWithFileTypes?.(skillPath.workspacePath)
				?.catch(() => []) ?? Promise.resolve([]),
			this.skillsFs
				?.readdirWithFileTypes?.(skillPath.globalPath)
				?.catch(() => []) ?? Promise.resolve([]),
		]).then(([workspaceEntries, globalEntries]) => {
			const byName = new Map<string, (typeof workspaceEntries)[number]>();
			for (const entry of workspaceEntries) {
				if (!this.blockedWorkspaceSkillDirs.has(entry.name))
					byName.set(entry.name, entry);
			}
			for (const entry of globalEntries) {
				if (
					!this.blockedGlobalSkillDirs.has(entry.name) &&
					!byName.has(entry.name)
				)
					byName.set(entry.name, entry as (typeof workspaceEntries)[number]);
			}
			return Array.from(byName.values()).sort((left, right) =>
				left.name.localeCompare(right.name),
			);
		});
	}
	rm: IFileSystem["rm"] = async (path, options) => {
		const routed = await this.writeRoute(path);
		return routed.fs.rm(routed.path, options);
	};
	cp: IFileSystem["cp"] = async (src, dest, options) => {
		const from = await this.writeRoute(src);
		const to = await this.writeRoute(dest);
		if (from.fs === to.fs) return from.fs.cp(from.path, to.path, options);
		throw new Error("Cross-filesystem copy is not supported for global skills");
	};
	mv: IFileSystem["mv"] = async (src, dest) => {
		const from = await this.writeRoute(src);
		const to = await this.writeRoute(dest);
		if (from.fs === to.fs) return from.fs.mv(from.path, to.path);
		throw new Error("Cross-filesystem move is not supported for global skills");
	};
	resolvePath: IFileSystem["resolvePath"] = (base, path) =>
		this.workspaceFs.resolvePath(base, path);
	getAllPaths: IFileSystem["getAllPaths"] = () => [
		...this.workspaceFs.getAllPaths(),
	];
	chmod: IFileSystem["chmod"] = async (path, mode) => {
		const routed = await this.writeRoute(path);
		return routed.fs.chmod(routed.path, mode);
	};
	symlink: IFileSystem["symlink"] = async (target, linkPath) => {
		const routed = await this.writeRoute(linkPath);
		return routed.fs.symlink(target, routed.path);
	};
	link: IFileSystem["link"] = async (existingPath, newPath) => {
		const from = await this.writeRoute(existingPath);
		const to = await this.writeRoute(newPath);
		if (from.fs === to.fs) return from.fs.link(from.path, to.path);
		throw new Error("Cross-filesystem link is not supported for global skills");
	};
	readlink: IFileSystem["readlink"] = async (path) => {
		const routed = await this.readRoute(path);
		return routed.fs.readlink(routed.path);
	};
	realpath: IFileSystem["realpath"] = async (path) => {
		const routed = await this.readRoute(path);
		return routed.fs.realpath(routed.path);
	};
	utimes: IFileSystem["utimes"] = async (path, atime, mtime) => {
		const routed = await this.writeRoute(path);
		return routed.fs.utimes(routed.path, atime, mtime);
	};
}

function hostCommand(workspaceRoot: string, name: string, bin = name) {
	return defineCommand(name, async (args, ctx) => {
		const cwd = isSandboxWorkspacePath(ctx.cwd)
			? sandboxToHostPath(ctx.cwd, workspaceRoot)
			: workspaceRoot;
		return await execHostCommand(bin, args, {
			cwd,
			stdin: ctx.stdin,
			signal: ctx.signal,
		});
	});
}

function canExecute(path: string) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveTeaBin() {
	if (process.env.AWARE_TEA_BIN && canExecute(process.env.AWARE_TEA_BIN)) {
		return process.env.AWARE_TEA_BIN;
	}
	const home = process.env.HOME;
	if (!home) return "tea";
	const teaRoot = join(home, ".tea", "tea.xyz");
	try {
		const versions = readdirSync(teaRoot).sort().reverse();
		for (const version of versions) {
			const bin = join(teaRoot, version, "bin", "tea");
			if (canExecute(bin)) return bin;
		}
	} catch {
		// Fall back to PATH lookup below.
	}
	return "tea";
}

function hostCommands(workspaceRoot: string) {
	return [
		hostCommand(workspaceRoot, "git"),
		hostCommand(workspaceRoot, "node"),
		hostCommand(workspaceRoot, "npm"),
		hostCommand(workspaceRoot, "npx"),
		hostCommand(workspaceRoot, "pnpm"),
		hostCommand(workspaceRoot, "corepack"),
		hostCommand(workspaceRoot, "bun"),
		hostCommand(workspaceRoot, "make"),
		hostCommand(workspaceRoot, "gh"),
		hostCommand(workspaceRoot, "tea", resolveTeaBin()),
		hostCommand(workspaceRoot, "python"),
		hostCommand(workspaceRoot, "python3", "python3"),
	];
}

export async function createLocalWorktreeSandbox({
	workspaceRoot,
	cwd,
	globalSkillsDir,
	blockedGlobalSkillDirs,
	blockedWorkspaceSkillDirs,
}: WorkspaceSandboxOptions): Promise<BashFactory> {
	const root = resolve(workspaceRoot);
	const hostCwd = await assertHostWorkspacePath(cwd, root);
	const sandboxCwd = hostToSandboxPath(hostCwd, root);
	const fs = new MountableFs({ base: new InMemoryFs() });
	fs.mount(
		SANDBOX_WORKSPACE_ROOT,
		new WorkspaceSkillsFs({
			workspaceRoot: root,
			globalSkillsDir,
			blockedGlobalSkillDirs,
			blockedWorkspaceSkillDirs,
		}),
	);
	const customCommands = hostCommands(root);
	return () =>
		capBashExecTimeout(
			new Bash({
				fs,
				cwd: sandboxCwd,
				env: process.env as Record<string, string>,
				customCommands,
				python: true,
				network: { dangerouslyAllowFullInternetAccess: true },
			}),
		);
}

export async function createDefaultEnv() {
	const fs = new InMemoryFs();
	return bashFactoryToSessionEnv(() =>
		capBashExecTimeout(
			new Bash({
				fs,
				env: process.env as Record<string, string>,
				customCommands: hostCommands(HOST_WORKSPACE_ROOT),
				python: true,
				network: { dangerouslyAllowFullInternetAccess: true },
			}),
		),
	);
}

export async function createLocalEnv() {
	return bashFactoryToSessionEnv(
		await createLocalWorktreeSandbox({
			workspaceRoot: HOST_WORKSPACE_ROOT,
			cwd: process.cwd(),
		}),
	);
}
