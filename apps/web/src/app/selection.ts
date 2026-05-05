const KEY = "aware-selection";

type ProjectScope = "files" | "tasks" | "runs";
type WorktreeScope = "files" | "runs" | "tasks";

type Selection = {
	selectedProjectIds: Partial<Record<ProjectScope, string>>;
	selectedWorktreeIds: Partial<Record<WorktreeScope, string>>;
	selectedWorktreeId: string;
	selectedTaskId: string;
	selectedRunId: string;
};

const empty: Selection = {
	selectedProjectIds: {},
	selectedWorktreeIds: {},
	selectedWorktreeId: "",
	selectedTaskId: "",
	selectedRunId: "",
};

function lastScopedWorktreeId(
	selectedWorktreeIds: Partial<Record<WorktreeScope, string>>,
) {
	return ["files", "runs", "tasks"]
		.map((scope) => selectedWorktreeIds[scope as WorktreeScope] || "")
		.find((id) => id && id !== "all") || "";
}

function read(): Selection {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Selection>;
		const selectedWorktreeIds = raw.selectedWorktreeIds || {};
		return {
			selectedProjectIds: raw.selectedProjectIds || {},
			selectedWorktreeIds,
			selectedWorktreeId:
				raw.selectedWorktreeId || lastScopedWorktreeId(selectedWorktreeIds),
			selectedTaskId: raw.selectedTaskId || "",
			selectedRunId: raw.selectedRunId || "",
		};
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

export function getSelectedProjectId(scope: ProjectScope) {
	return read().selectedProjectIds[scope] || "";
}

export function setSelectedProjectId(id: string, scope: ProjectScope) {
	const current = read();
	write({
		...current,
		selectedProjectIds: { ...current.selectedProjectIds, [scope]: id },
		selectedWorktreeIds: { ...current.selectedWorktreeIds, [scope]: "" },
		selectedWorktreeId: "",
		selectedTaskId: "",
		selectedRunId: "",
	});
}

export function getSelectedWorktreeId(scope: WorktreeScope) {
	const current = read();
	const scoped = current.selectedWorktreeIds[scope] || "";
	return scoped === "all" ? scoped : current.selectedWorktreeId || scoped;
}

export function setSelectedWorktreeId(id: string, scope: WorktreeScope) {
	const current = read();
	const selectedWorktreeIds =
		id && id !== "all"
			? { files: id, runs: id, tasks: id }
			: { ...current.selectedWorktreeIds, [scope]: id };
	write({
		...current,
		selectedWorktreeIds,
		selectedWorktreeId:
			id && id !== "all" ? id : current.selectedWorktreeId,
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
