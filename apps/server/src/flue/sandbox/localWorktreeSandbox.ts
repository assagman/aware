import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

type WorkspaceSandboxOptions = {
	workspaceRoot: string;
	cwd: string;
};

function hostCommand(workspaceRoot: string, name: string, bin = name) {
	return defineCommand(name, async (args, ctx) => {
		const cwd = isSandboxWorkspacePath(ctx.cwd)
			? sandboxToHostPath(ctx.cwd, workspaceRoot)
			: workspaceRoot;
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

function hostCommands(workspaceRoot: string) {
	return [
		hostCommand(workspaceRoot, "git"),
		hostCommand(workspaceRoot, "node"),
		hostCommand(workspaceRoot, "npm"),
		hostCommand(workspaceRoot, "npx"),
		hostCommand(workspaceRoot, "pnpm"),
		hostCommand(workspaceRoot, "corepack"),
		hostCommand(workspaceRoot, "bun"),
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
		new Bash({
			fs,
			cwd: sandboxCwd,
			env: process.env as Record<string, string>,
			customCommands,
			python: true,
			network: { dangerouslyAllowFullInternetAccess: true },
		});
}

export async function createDefaultEnv() {
	const fs = new InMemoryFs();
	return bashFactoryToSessionEnv(
		() =>
			new Bash({
				fs,
				env: process.env as Record<string, string>,
				customCommands: hostCommands(HOST_WORKSPACE_ROOT),
				python: true,
				network: { dangerouslyAllowFullInternetAccess: true },
			}),
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
