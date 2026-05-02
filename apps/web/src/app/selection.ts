const KEY = "agent-ide-selection";

type Selection = {
	selectedProjectId: string;
	selectedWorktreeId: string;
	selectedTaskId: string;
	selectedRunId: string;
};

const empty: Selection = {
	selectedProjectId: "",
	selectedWorktreeId: "",
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
	localStorage.setItem(KEY, JSON.stringify(selection));
	window.dispatchEvent(new Event("agent-ide-selection"));
}

export function getSelection() {
	return read();
}

export function setSelectedProjectId(id: string) {
	write({
		...read(),
		selectedProjectId: id,
		selectedWorktreeId: "",
		selectedTaskId: "",
		selectedRunId: "",
	});
}

export function setSelectedWorktreeId(id: string) {
	write({
		...read(),
		selectedWorktreeId: id,
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
