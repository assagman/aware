import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
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
};

type RoutedFs = {
	fs: IFileSystem;
	path: string;
};

function defaultGlobalSkillsDir() {
	return process.env.AWARE_GLOBAL_SKILLS_DIR ?? join(homedir(), ".agents", "skills");
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

	constructor(options: {
		workspaceRoot: string;
		globalSkillsDir?: string | undefined;
	}) {
		this.workspaceFs = new ReadWriteFs({ root: options.workspaceRoot });
		const skillsDir = options.globalSkillsDir ?? defaultGlobalSkillsDir();
		if (existingDirectory(skillsDir)) {
			this.skillsFs = new OverlayFs({
				root: skillsDir,
				mountPoint: "/",
				readOnly: true,
			});
		}
	}

	private route(path: string): RoutedFs {
		if (this.skillsFs) {
			const normalized = posix.normalize(path.startsWith("/") ? path : `/${path}`);
			const marker = "/.agents/skills";
			const markerIndex = normalized.indexOf(marker);
			if (markerIndex >= 0) {
				const rest = normalized.slice(markerIndex + marker.length);
				if (!rest || rest.startsWith("/"))
					return { fs: this.skillsFs, path: rest || "/" };
			}
		}
		return { fs: this.workspaceFs, path };
	}

	readFile: IFileSystem["readFile"] = (path, options) => {
		const routed = this.route(path);
		return routed.fs.readFile(routed.path, options);
	};
	readFileBuffer: IFileSystem["readFileBuffer"] = (path) => {
		const routed = this.route(path);
		return routed.fs.readFileBuffer(routed.path);
	};
	writeFile: IFileSystem["writeFile"] = (path, content, options) => {
		const routed = this.route(path);
		return routed.fs.writeFile(routed.path, content, options);
	};
	appendFile: IFileSystem["appendFile"] = (path, content, options) => {
		const routed = this.route(path);
		return routed.fs.appendFile(routed.path, content, options);
	};
	exists: IFileSystem["exists"] = (path) => {
		const routed = this.route(path);
		return routed.fs.exists(routed.path);
	};
	stat: IFileSystem["stat"] = (path) => {
		const routed = this.route(path);
		return routed.fs.stat(routed.path);
	};
	lstat: IFileSystem["lstat"] = (path) => {
		const routed = this.route(path);
		return routed.fs.lstat(routed.path);
	};
	mkdir: IFileSystem["mkdir"] = (path, options) => {
		const routed = this.route(path);
		return routed.fs.mkdir(routed.path, options);
	};
	readdir: IFileSystem["readdir"] = (path) => {
		const routed = this.route(path);
		return routed.fs.readdir(routed.path);
	};
	readdirWithFileTypes(path: string) {
		const routed = this.route(path);
		return routed.fs.readdirWithFileTypes?.(routed.path) ?? Promise.resolve([]);
	}
	rm: IFileSystem["rm"] = (path, options) => {
		const routed = this.route(path);
		return routed.fs.rm(routed.path, options);
	};
	cp: IFileSystem["cp"] = (src, dest, options) => {
		const from = this.route(src);
		const to = this.route(dest);
		if (from.fs === to.fs) return from.fs.cp(from.path, to.path, options);
		throw new Error("Cross-filesystem copy is not supported for global skills");
	};
	mv: IFileSystem["mv"] = (src, dest) => {
		const from = this.route(src);
		const to = this.route(dest);
		if (from.fs === to.fs) return from.fs.mv(from.path, to.path);
		throw new Error("Cross-filesystem move is not supported for global skills");
	};
	resolvePath: IFileSystem["resolvePath"] = (base, path) =>
		this.workspaceFs.resolvePath(base, path);
	getAllPaths: IFileSystem["getAllPaths"] = () => [
		...this.workspaceFs.getAllPaths(),
	];
	chmod: IFileSystem["chmod"] = (path, mode) => {
		const routed = this.route(path);
		return routed.fs.chmod(routed.path, mode);
	};
	symlink: IFileSystem["symlink"] = (target, linkPath) => {
		const routed = this.route(linkPath);
		return routed.fs.symlink(target, routed.path);
	};
	link: IFileSystem["link"] = (existingPath, newPath) => {
		const from = this.route(existingPath);
		const to = this.route(newPath);
		if (from.fs === to.fs) return from.fs.link(from.path, to.path);
		throw new Error("Cross-filesystem link is not supported for global skills");
	};
	readlink: IFileSystem["readlink"] = (path) => {
		const routed = this.route(path);
		return routed.fs.readlink(routed.path);
	};
	realpath: IFileSystem["realpath"] = (path) => {
		const routed = this.route(path);
		return routed.fs.realpath(routed.path);
	};
	utimes: IFileSystem["utimes"] = (path, atime, mtime) => {
		const routed = this.route(path);
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
		hostCommand(workspaceRoot, "tea", resolveTeaBin()),
		hostCommand(workspaceRoot, "python"),
		hostCommand(workspaceRoot, "python3", "python3"),
	];
}

export async function createLocalWorktreeSandbox({
	workspaceRoot,
	cwd,
	globalSkillsDir,
}: WorkspaceSandboxOptions): Promise<BashFactory> {
	const root = resolve(workspaceRoot);
	const hostCwd = await assertHostWorkspacePath(cwd, root);
	const sandboxCwd = hostToSandboxPath(hostCwd, root);
	const fs = new MountableFs({ base: new InMemoryFs() });
	fs.mount(
		SANDBOX_WORKSPACE_ROOT,
		new WorkspaceSkillsFs({ workspaceRoot: root, globalSkillsDir }),
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
