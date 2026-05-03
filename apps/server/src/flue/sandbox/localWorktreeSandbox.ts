import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

function hostCommand(name: string, bin = name) {
	return defineCommand(name, async (args, ctx) => {
		const cwd = isSandboxWorkspacePath(ctx.cwd)
			? sandboxToHostPath(ctx.cwd)
			: process.cwd();
		try {
			const { stdout, stderr } = await execFileAsync(bin, args, {
				cwd,
				env: process.env,
				maxBuffer: 1024 * 1024 * 20,
			});
			return { stdout, stderr, exitCode: 0 };
		} catch (error) {
			const e = error as { stdout?: string; stderr?: string; code?: number };
			return {
				stdout: e.stdout ?? "",
				stderr:
					e.stderr ??
					(error instanceof Error ? `${error.message}\n` : String(error)),
				exitCode: typeof e.code === "number" ? e.code : 1,
			};
		}
	});
}

const hostCommands = [
	hostCommand("git"),
	hostCommand("node"),
	hostCommand("npm"),
	hostCommand("npx"),
	hostCommand("pnpm"),
	hostCommand("corepack"),
	hostCommand("bun"),
	hostCommand("python"),
	hostCommand("python3", "python3"),
];

export function createLocalWorktreeSandbox(worktreePath: string) {
	return { kind: "local-worktree", worktreePath };
}

export async function createDefaultEnv() {
	const fs = new InMemoryFs();
	return bashFactoryToSessionEnv(
		() =>
			new Bash({
				fs,
				env: process.env as Record<string, string>,
				customCommands: hostCommands,
				python: true,
				network: { dangerouslyAllowFullInternetAccess: true },
			}),
	);
}

export async function createLocalEnv() {
	const hostCwd = await assertHostWorkspacePath(process.cwd());
	const cwd = hostToSandboxPath(hostCwd);
	const rwfs = new ReadWriteFs({ root: HOST_WORKSPACE_ROOT });
	const fs = new MountableFs({ base: new InMemoryFs() });
	fs.mount(SANDBOX_WORKSPACE_ROOT, rwfs);
	return bashFactoryToSessionEnv(
		() =>
			new Bash({
				fs,
				cwd,
				env: process.env as Record<string, string>,
				customCommands: hostCommands,
				python: true,
				network: { dangerouslyAllowFullInternetAccess: true },
			}),
	);
}

export async function runInWorktree<T>(
	worktreePath: string,
	fn: () => Promise<T>,
) {
	const previous = process.cwd();
	process.chdir(worktreePath);
	try {
		return await fn();
	} finally {
		process.chdir(previous);
	}
}
