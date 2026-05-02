import { bashFactoryToSessionEnv } from "@flue/sdk/internal";
import { Bash, InMemoryFs, MountableFs, ReadWriteFs } from "just-bash";

export function createLocalWorktreeSandbox(worktreePath: string) {
	return { kind: "local-worktree", worktreePath };
}

export async function createDefaultEnv() {
	const fs = new InMemoryFs();
	return bashFactoryToSessionEnv(
		() =>
			new Bash({ fs, network: { dangerouslyAllowFullInternetAccess: true } }),
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
