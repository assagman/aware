const pending = new Set<string>();

export function needsApproval(command: string) {
	return /^git\s+(commit|push)\b/.test(command.trim());
}

export function requestApproval(runId: string, command: string) {
	const id = `${runId}:${command}`;
	pending.add(id);
	return id;
}

export function approve(id: string) {
	pending.delete(id);
	return true;
}
