const locks = new Map<string, string>();
const queues = new Map<string, Promise<unknown>>();
const queueTails = new Map<string, Promise<unknown>>();

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

export async function withQueuedLock<T>(
	key: string,
	fn: () => Promise<T>,
): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(
		() => current,
		() => current,
	);
	queues.set(key, tail);
	queueTails.set(key, current);
	await previous.catch(() => undefined);
	try {
		return await fn();
	} finally {
		release();
		if (queueTails.get(key) === current) {
			queues.delete(key);
			queueTails.delete(key);
		}
	}
}

export function getQueuedLockKeys() {
	return Array.from(queues.keys());
}
