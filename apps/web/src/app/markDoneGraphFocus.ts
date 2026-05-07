import type { AgentRun, Task } from "@aware/shared";

type FocusNode = { id: string; data: { taskId?: string | undefined } };

export function focusedGraphNodeIds(nodes: FocusNode[], taskId: string) {
	if (!taskId) return [];
	return nodes
		.filter((node) => node.data.taskId === taskId)
		.map((node) => ({ id: "id" in node ? String(node.id) : "" }))
		.filter((node) => node.id);
}

export function projectGraphFocusPath(projectId: string, taskId: string) {
	if (!projectId || !taskId) return "";
	return `/projects/${encodeURIComponent(projectId)}?${new URLSearchParams({ focusTaskId: taskId })}`;
}

export function markDoneGraphTarget(input: {
	projectId?: string | undefined;
	taskId?: string | undefined;
	run?: AgentRun | undefined;
	task?: Task | undefined;
}) {
	const projectId = input.projectId || input.task?.projectId || "";
	const taskId = input.taskId || input.task?.id || input.run?.taskId || "";
	return projectGraphFocusPath(projectId, taskId);
}

export async function runAfterMarkDoneSuccess(input: {
	mutation: () => Promise<unknown>;
	navigate: (href: string) => void;
	projectId?: string | undefined;
	taskId?: string | undefined;
	run?: AgentRun | undefined;
	task?: Task | undefined;
	afterSuccess?: (() => Promise<unknown> | unknown) | undefined;
}) {
	await input.mutation();
	await input.afterSuccess?.();
	const target = markDoneGraphTarget(input);
	if (!target) return false;
	input.navigate(target);
	return true;
}
