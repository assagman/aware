import type { AgentRun, Task } from "@aware/shared";

type FocusNode = { id: string; data: { taskId?: string | undefined } };

export function activeGraphFocusNodeId(
	focusNodeId: string,
	consumedFocusNodeId: string,
) {
	return focusNodeId && focusNodeId !== consumedFocusNodeId ? focusNodeId : "";
}

export function shouldSkipGraphViewportSync(
	focusNodeId: string,
	activeFocusNodeId: string,
	focusTaskId: string,
) {
	return Boolean(focusNodeId && !activeFocusNodeId && !focusTaskId);
}

export function focusedGraphNodeIds(
	nodes: FocusNode[],
	input: string | { nodeId?: string | undefined; taskId?: string | undefined },
) {
	const nodeId = typeof input === "string" ? "" : input.nodeId || "";
	if (nodeId && nodes.some((node) => node.id === nodeId))
		return [{ id: nodeId }];
	const taskId = typeof input === "string" ? input : input.taskId || "";
	if (!taskId) return [];
	return nodes
		.filter((node) => node.data.taskId === taskId)
		.map((node) => ({ id: String(node.id) }))
		.filter((node) => node.id);
}

export function graphNodeFocusPath(projectId: string, nodeId: string) {
	if (!projectId || !nodeId) return "";
	return `/projects/${encodeURIComponent(projectId)}?${new URLSearchParams({ focus: nodeId })}`;
}

export function projectGraphFocusPath(projectId: string, taskId: string) {
	if (!projectId || !taskId) return "";
	return `/projects/${encodeURIComponent(projectId)}?${new URLSearchParams({ focusTaskId: taskId })}`;
}

export function markDoneGraphTarget(input: {
	projectId?: string | undefined;
	taskId?: string | undefined;
	runId?: string | undefined;
	focusNodeId?: string | undefined;
	run?: AgentRun | undefined;
	task?: Task | undefined;
}) {
	const projectId = input.projectId || input.task?.projectId || "";
	const taskId = input.taskId || input.task?.id || input.run?.taskId || "";
	const runId = input.runId || input.run?.id || "";
	const nodeId =
		input.focusNodeId ||
		(runId ? `run:${runId}` : taskId ? `checkpoint:${taskId}` : "");
	return graphNodeFocusPath(projectId, nodeId);
}

export async function runAfterMarkDoneSuccess(input: {
	mutation: () => Promise<unknown>;
	navigate: (href: string) => unknown;
	projectId?: string | undefined;
	taskId?: string | undefined;
	runId?: string | undefined;
	focusNodeId?: string | undefined;
	run?: AgentRun | undefined;
	task?: Task | undefined;
	afterSuccess?: (() => Promise<unknown> | unknown) | undefined;
}) {
	await input.mutation();
	await input.afterSuccess?.();
	const target = markDoneGraphTarget(input);
	if (!target) return false;
	return input.navigate(target) !== false;
}
