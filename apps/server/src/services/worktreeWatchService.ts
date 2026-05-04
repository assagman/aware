import { EventEmitter } from "node:events";
import { dirname, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { Worktree } from "@aware/shared";
import { listWorktrees } from "./projectService";

type WorktreeWatchEvent = {
	type: "files" | "worktrees";
	worktreeId?: string;
	projectId?: string;
	path?: string;
	at: string;
};

const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	".next",
	"coverage",
]);

function ignored(path: string) {
	return path.split(sep).some((part) => IGNORED_DIRS.has(part));
}

class WorktreeWatchService {
	private emitter = new EventEmitter();
	private watchers = new Map<string, FSWatcher>();
	private parentWatchers = new Map<string, FSWatcher>();
	private worktrees = new Map<string, Worktree>();
	private debounce = new Map<string, ReturnType<typeof setTimeout>>();
	private refreshInFlight: Promise<void> | null = null;

	subscribe(listener: (event: WorktreeWatchEvent) => void) {
		this.emitter.on("event", listener);
		return () => this.emitter.off("event", listener);
	}

	async watch(worktreeId: string) {
		if (!worktreeId) return;
		await this.refreshWorktrees();
		const worktree = this.worktrees.get(worktreeId);
		if (worktree && !this.watchers.has(worktree.id)) this.watchWorktree(worktree);
	}

	private emit(event: Omit<WorktreeWatchEvent, "at">) {
		this.emitter.emit("event", { ...event, at: new Date().toISOString() });
	}

	private scheduleFiles(worktree: Worktree, path = "") {
		const key = `files:${worktree.id}`;
		const existing = this.debounce.get(key);
		if (existing) clearTimeout(existing);
		this.debounce.set(
			key,
			setTimeout(() => {
				this.debounce.delete(key);
				this.emit({
					type: "files",
					worktreeId: worktree.id,
					projectId: worktree.projectId,
					path,
				});
			}, 120),
		);
	}

	private scheduleWorktreeRefresh() {
		const key = "worktrees";
		const existing = this.debounce.get(key);
		if (existing) clearTimeout(existing);
		this.debounce.set(
			key,
			setTimeout(() => {
				this.debounce.delete(key);
				void this.refreshWorktrees(true);
			}, 180),
		);
	}

	private async refreshWorktrees(emit = false) {
		if (this.refreshInFlight) return this.refreshInFlight;
		this.refreshInFlight = this.doRefreshWorktrees(emit).finally(() => {
			this.refreshInFlight = null;
		});
		return this.refreshInFlight;
	}

	private async doRefreshWorktrees(emitChanges: boolean) {
		const rows = await listWorktrees().catch(() => []);
		const next = new Map(rows.map((worktree) => [worktree.id, worktree]));
		for (const [id, watcher] of this.watchers) {
			if (!next.has(id)) {
				await watcher.close().catch(() => undefined);
				await this.parentWatchers.get(id)?.close().catch(() => undefined);
				this.watchers.delete(id);
				this.parentWatchers.delete(id);
				this.emit({ type: "worktrees", worktreeId: id });
			}
		}
		for (const worktree of rows) {
			const previous = this.worktrees.get(worktree.id);
			if (previous && previous.path !== worktree.path && this.watchers.has(worktree.id))
				this.watchWorktree(worktree);
			if (
				emitChanges &&
				(!previous ||
					previous.path !== worktree.path ||
					previous.branch !== worktree.branch)
			)
				this.emit({
					type: "worktrees",
					worktreeId: worktree.id,
					projectId: worktree.projectId,
				});
		}
		this.worktrees = next;
	}

	private watchWorktree(worktree: Worktree) {
		void this.watchers.get(worktree.id)?.close();
		void this.parentWatchers.get(worktree.id)?.close();
		const watcher = chokidar.watch(worktree.path, {
			ignoreInitial: true,
			ignored,
			awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
		});
		watcher.on("all", (_event, path) => this.scheduleFiles(worktree, path));
		watcher.on("unlinkDir", (path) => {
			if (path === worktree.path) this.scheduleWorktreeRefresh();
		});
		watcher.on("error", () => this.scheduleWorktreeRefresh());
		this.watchers.set(worktree.id, watcher);

		const parentWatcher = chokidar.watch(dirname(worktree.path), {
			depth: 0,
			ignoreInitial: true,
			ignored,
		});
		parentWatcher.on("all", () => this.scheduleWorktreeRefresh());
		parentWatcher.on("error", () => this.scheduleWorktreeRefresh());
		this.parentWatchers.set(worktree.id, parentWatcher);
	}
}

export const worktreeWatchService = new WorktreeWatchService();
