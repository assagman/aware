import type { Task, Worktree } from "@aware/shared";
import { flueRuntime } from "./agentRuntime/flueRuntime";
import { listGraphAgentsForRun } from "./graphAgentService";
import { listWorktrees } from "./projectService";
import {
	getProjectOrThrow,
	getTaskInProjectOrThrow,
	getWorktreeInProjectOrThrow,
	RouteValidationError,
} from "./graph/validation";

export type GraphAgentMode = "task_runs" | "gate_runs" | "ship_prep";

function projectWorktree(projectId: string, worktrees: Worktree[]) {
	const scoped = worktrees.filter((worktree) => worktree.projectId === projectId);
	return scoped.find((worktree) => worktree.branch === "main")
		?? scoped.find((worktree) => worktree.branch === "master")
		?? scoped[0];
}

function modeTitle(mode: GraphAgentMode) {
	if (mode === "task_runs") return "Auto create task runs";
	if (mode === "gate_runs") return "Auto create gate runs";
	return "Auto ship prep";
}

function modePrompt(input: { mode: GraphAgentMode; projectId: string; task: Task }) {
	const base = [
		`Mode: ${input.mode}`,
		`Project id: ${input.projectId}`,
		`Task id: ${input.task.id}`,
		`Task title: ${input.task.title}`,
		"",
		"Task brief:",
		input.task.body || "(none)",
		"",
		"Instructions:",
	];
	if (input.mode === "task_runs")
		return [
			...base,
			"Use graph_get_projection, inspect existing task-lane runs, then create missing task-lane implementation runs for this task using graph_start_run with lane 'task'.",
			"Create concrete, non-overlapping parallel runs that together cover the task. Avoid duplicates.",
		].join("\n");
	if (input.mode === "gate_runs")
		return [
			...base,
			"Use graph_get_projection, inspect existing gate-lane runs, then create missing gate-lane validation runs for this task using graph_start_run with lane 'gate'.",
			"Cover code review, tests, security, performance, docs, and release notes only when relevant. Avoid duplicates.",
		].join("\n");
	return [
		...base,
		"Use graph_get_projection, inspect existing gate and ship runs, then create missing ship-prep evidence runs using graph_start_run with lane 'gate'.",
		"Focus on release readiness, final regression checklist, PR/commit readiness review, and risk sign-off. Never start final shipping or ship lane.",
	].join("\n");
}

export async function startGraphAgentRunCommand(input: {
	projectId: string;
	taskId: string;
	mode: GraphAgentMode;
}) {
	const task = await getTaskInProjectOrThrow(input.projectId, input.taskId);
	const project = await getProjectOrThrow(input.projectId);
	const worktree = task.worktreeId
		? await getWorktreeInProjectOrThrow(project.id, task.worktreeId)
		: projectWorktree(project.id, await listWorktrees());
	if (!worktree) throw new RouteValidationError("project has no worktree for graph agent", 409);
	const agents = await listGraphAgentsForRun();
	return flueRuntime.startRun({
		task: {
			...task,
			worktreeId: worktree.id,
			body: [
				"Graph Agent context:",
				`Project: ${project.name}`,
				`Project id: ${project.id}`,
				`Task id: ${task.id}`,
				`Mode: ${input.mode}`,
				"",
				"Task brief:",
				task.body || "(none)",
			].join("\n"),
		},
		worktreeId: worktree.id,
		worktreePath: worktree.path,
		agents,
		message: modePrompt({ mode: input.mode, projectId: project.id, task }),
		relation: "parallel",
		lane: "graph",
		affectsTaskStatus: false,
		completedStatus: "done",
	});
}

export function graphAgentRunLabel(mode: GraphAgentMode) {
	return modeTitle(mode);
}
