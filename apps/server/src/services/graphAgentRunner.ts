import type { AgentRun, Task, Worktree } from "@aware/shared";
import { db } from "../db/client";
import { flueRuntime } from "./agentRuntime/flueRuntime";
import { listGraphAutomationAgentsForRun } from "./graphAutomationAgentService";
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

async function modeAgents(mode: GraphAgentMode) {
	return mode === "task_runs" ? listGraphAutomationAgentsForRun() : listGraphAgentsForRun();
}

const executionPlanContract = [
	"## Execution plan contract",
	"",
	"Main must plan; Graph Agent must mutate only. Handoff to Graph Agent with this normalized JSON shape:",
	"",
	"```json",
	"{",
	"  \"version\": 1,",
	"  \"projectId\": \"<project id>\",",
	"  \"taskId\": \"<task id>\",",
	"  \"duplicateAvoidance\": [\"Inspect graph_get_projection first\", \"Do not create runs equivalent to active/completed runs\"],",
	"  \"runs\": [",
	"    {",
	"      \"planId\": \"short-stable-ref\",",
	"      \"title\": \"Concise purpose\",",
	"      \"lane\": \"task\",",
	"      \"relation\": \"parallel\",",
	"      \"dependsOn\": [],",
	"      \"parentPlanId\": null,",
	"      \"prompt\": \"Concrete scoped run prompt with files/areas, deliverables, tests, and non-overlap boundaries\"",
	"    }",
	"  ]",
	"}",
	"```",
	"",
	"Rules: lane must be 'task'; relation is 'parallel' unless the run requires output from a prior run; sequential runs must set parentPlanId to the immediate predecessor planId. Use dependsOn for human-readable dependency context. Prompts must be executable standalone and explicitly mention duplicate/non-overlap boundaries. Graph Agent must pass the complete object to graph_start_execution_plan so the server can machine-validate the complete plan before creating runs.",
].join("\n");

function modePrompt(input: { mode: GraphAgentMode; projectId: string; task: Task }) {
	const base = [
		"## Run context",
		"",
		`- **Mode:** ${input.mode}`,
		`- **Project id:** ${input.projectId}`,
		`- **Task id:** ${input.task.id}`,
		`- **Task title:** ${input.task.title}`,
		"",
		"## Task brief",
		"",
		input.task.body || "(none)",
		"",
		"## Instructions",
	];
	if (input.mode === "task_runs")
		return [
			...base,
			executionPlanContract,
			"",
			"Analyze the task as Main. Break down all required implementation work into the structured execution plan before any graph mutation.",
			"Prefer parallel task-lane runs only where independent. Use sequential task-lane runs when one run needs another run's output; set parentPlanId/dependsOn accordingly.",
			"Then call delegate_agent exactly once with role `graph-agent`, passing the complete execution plan. Instruct Graph Agent to: call graph_get_projection, avoid duplicate active/completed equivalent runs, then call graph_start_execution_plan exactly once with the full plan so the server can machine-validate the complete plan before creating runs.",
			"Do not call graph_* tools directly from Main; Graph Agent owns graph mutation and Main's tool scope is planning-only.",
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

const graphAutomationLocks = new Map<string, Promise<AgentRun>>();

function automationLockKey(input: { projectId: string; taskId: string; mode: GraphAgentMode }) {
	return `${input.projectId}:${input.taskId}:${input.mode}`;
}

function isActiveGraphAutomationRun(run: AgentRun, input: { taskId: string; mode: GraphAgentMode }) {
	return !run.deletedAt
		&& run.taskId === input.taskId
		&& run.lane === "graph"
		&& (run.status === "running" || run.status === "queued")
		&& (run.request ?? "").includes(`- **Mode:** ${input.mode}`);
}

async function activeGraphAutomationRun(input: { taskId: string; mode: GraphAgentMode }) {
	return (await db.list<AgentRun>("runs")).find((run) => isActiveGraphAutomationRun(run, input));
}

async function startGraphAgentRunUnlocked(input: {
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
	const active = await activeGraphAutomationRun({ taskId: task.id, mode: input.mode });
	if (active) return active;
	const agents = await modeAgents(input.mode);
	return flueRuntime.startRun({
		task: {
			...task,
			worktreeId: worktree.id,
			body: [
				"## Graph agent context",
				"",
				`- **Project:** ${project.name}`,
				`- **Project id:** ${project.id}`,
				`- **Task id:** ${task.id}`,
				`- **Mode:** ${input.mode}`,
				"",
				"## Task brief",
				"",
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

export async function startGraphAgentRunCommand(input: {
	projectId: string;
	taskId: string;
	mode: GraphAgentMode;
}) {
	const key = automationLockKey(input);
	const pending = graphAutomationLocks.get(key);
	if (pending) return pending;
	const run = startGraphAgentRunUnlocked(input).finally(() => {
		graphAutomationLocks.delete(key);
	});
	graphAutomationLocks.set(key, run);
	return run;
}

export function graphAgentRunLabel(mode: GraphAgentMode) {
	return modeTitle(mode);
}
