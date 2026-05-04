const KEY = "aware-selection";

type ProjectScope = "files" | "tasks" | "runs";
type WorktreeScope = "files" | "runs" | "tasks";

type Selection = {
	selectedProjectIds: Partial<Record<ProjectScope, string>>;
	selectedWorktreeIds: Partial<Record<WorktreeScope, string>>;
	selectedTaskId: string;
	selectedRunId: string;
};

const empty: Selection = {
	selectedProjectIds: {},
	selectedWorktreeIds: {},
	selectedTaskId: "",
	selectedRunId: "",
};

function read(): Selection {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Selection>;
		return {
			selectedProjectIds: raw.selectedProjectIds || {},
			selectedWorktreeIds: raw.selectedWorktreeIds || {},
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
		selectedTaskId: "",
		selectedRunId: "",
	});
}

export function getSelectedWorktreeId(scope: WorktreeScope) {
	return read().selectedWorktreeIds[scope] || "";
}

export function setSelectedWorktreeId(id: string, scope: WorktreeScope) {
	const current = read();
	write({
		...current,
		selectedWorktreeIds: { ...current.selectedWorktreeIds, [scope]: id },
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
