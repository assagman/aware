import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BashFactory } from "@flue/sdk/client";
import { bashFactoryToSessionEnv } from "@flue/sdk/internal";
import {
	Bash,
	defineCommand,
	InMemoryFs,
	MountableFs,
	ReadWriteFs,
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
};

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
}: WorkspaceSandboxOptions): Promise<BashFactory> {
	const root = resolve(workspaceRoot);
	const hostCwd = await assertHostWorkspacePath(cwd, root);
	const sandboxCwd = hostToSandboxPath(hostCwd, root);
	const fs = new MountableFs({ base: new InMemoryFs() });
	fs.mount(SANDBOX_WORKSPACE_ROOT, new ReadWriteFs({ root }));
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
