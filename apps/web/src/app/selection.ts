const KEY = "aware-selection";

type WorktreeScope = "files" | "diffs" | "runs" | "tasks";

type Selection = {
	selectedProjectId: string;
	selectedWorktreeId: string;
	selectedWorktreeIds: Partial<Record<WorktreeScope, string>>;
	selectedTaskId: string;
	selectedRunId: string;
};

const empty: Selection = {
	selectedProjectId: "",
	selectedWorktreeId: "",
	selectedWorktreeIds: {},
	selectedTaskId: "",
	selectedRunId: "",
};

function read(): Selection {
	try {
		return { ...empty, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
	} catch {
		return empty;
	}
}

function write(selection: Selection) {
	const before = JSON.stringify(read());
	const after = JSON.stringify(selection);
	if (before === after) return;
	localStorage.setItem(KEY, after);
	window.dispatchEvent(new Event("aware-selection"));
}

export function getSelection() {
	return read();
}

export function setSelectedProjectId(id: string) {
	write({
		...read(),
		selectedProjectId: id,
		selectedWorktreeId: "",
		selectedWorktreeIds: {},
		selectedTaskId: "",
		selectedRunId: "",
	});
}

export function getSelectedWorktreeId(scope: WorktreeScope) {
	const selection = read();
	const scoped = selection.selectedWorktreeIds[scope];
	if (scope !== "runs" && scoped === "all") return selection.selectedWorktreeId;
	return scoped || selection.selectedWorktreeId || "";
}

export function setSelectedWorktreeId(id: string, scope?: WorktreeScope) {
	const current = read();
	const syncAll = id !== "all";
	write({
		...current,
		selectedWorktreeId: syncAll ? id : current.selectedWorktreeId,
		selectedWorktreeIds: scope
			? syncAll
				? {
						...current.selectedWorktreeIds,
						files: id,
						diffs: id,
						runs: id,
						tasks: id,
						[scope]: id,
					}
				: { ...current.selectedWorktreeIds, [scope]: id }
			: current.selectedWorktreeIds,
		selectedTaskId: "",
		selectedRunId: "",
	});
}

export function setSelectedTaskId(id: string) {
	write({ ...read(), selectedTaskId: id });
}

export function setSelectedRunId(id: string) {
	write({ ...read(), selectedRunId: id });
}
