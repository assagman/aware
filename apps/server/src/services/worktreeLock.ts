const locks = new Map<string, string>();

export async function withWorktreeLock<T>(
	worktreeId: string,
	owner: string,
	fn: () => Promise<T>,
): Promise<T> {
	if (locks.has(worktreeId)) throw new Error("Worktree locked");
	locks.set(worktreeId, owner);
	try {
		return await fn();
	} finally {
		if (locks.get(worktreeId) === owner) locks.delete(worktreeId);
	}
}

export function getLock(worktreeId: string) {
	return locks.get(worktreeId) ?? null;
}
