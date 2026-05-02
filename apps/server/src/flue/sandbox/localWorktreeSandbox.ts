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

const execFileAsync = promisify(execFile);

function hostCommand(name: string, bin = name) {
	return defineCommand(name, async (args, ctx) => {
		const root = process.cwd();
		const cwd = ctx.cwd.startsWith("/workspace")
			? `${root}${ctx.cwd.slice("/workspace".length)}`
			: root;
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
	const rwfs = new ReadWriteFs({ root: process.cwd() });
	const fs = new MountableFs({ base: new InMemoryFs() });
	fs.mount("/workspace", rwfs);
	return bashFactoryToSessionEnv(
		() =>
			new Bash({
				fs,
				cwd: "/workspace",
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
