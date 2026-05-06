import type {
	AgentRun,
	GraphAction,
	GraphProjection,
	GraphProjectionEdge,
	GraphProjectionNode,
	Project,
	RunLane,
	RunRelation,
	Task,
	TaskStatus,
	Worktree,
} from "@aware/shared";
import { db } from "../../db/client";
import { listProjects, listStoredWorktrees, listWorktrees } from "../projectService";
import { listTasks } from "../taskService";

const taskStatusOrder: Record<TaskStatus, number> = {
	running: 0,
	need_review: 1,
	queued: 2,
	failed: 3,
	draft: 4,
	done: 5,
};

const GRAPH_X = {
	project: 36,
	task: 390,
	run: 760,
	gate: 1120,
	gateRun: 1460,
	ship: 1860,
};
const GRAPH_ROW_START_Y = 72;
const GRAPH_ROW_GAP = 112;
const GRAPH_ROW_VERTICAL_PADDING = 152;
const GRAPH_RUN_LANE_GAP = 220;
const GRAPH_RUN_DEPTH_GAP = 340;
const GRAPH_RUN_NODE_WIDTH = 240;
const GRAPH_RUN_NODE_HEIGHT = 116;
const GRAPH_ADD_RUN_NODE_WIDTH = 62;
const GRAPH_ADD_RUN_NODE_HEIGHT = 58;
const GRAPH_ADD_RUN_CENTER_OFFSET = {
	x: (GRAPH_RUN_NODE_WIDTH - GRAPH_ADD_RUN_NODE_WIDTH) / 2,
	y: (GRAPH_RUN_NODE_HEIGHT - GRAPH_ADD_RUN_NODE_HEIGHT) / 2,
};
const RUN_LAYOUT_ROOT = "__root__";
const RUN_CANDIDATE_STARTED_AT = "9999-12-31T23:59:59.999Z";

type LayoutRun = Pick<AgentRun, "id" | "startedAt"> & {
	parentRunId?: string | undefined;
	relation?: RunRelation | undefined;
};

type RunLayoutPosition = { depth: number; lane: number };
type RunLayout<T extends LayoutRun = LayoutRun> = {
	sorted: T[];
	positions: Map<string, RunLayoutPosition>;
	laneCount: number;
	minLane: number;
	maxLane: number;
	maxDepth: number;
};

function worktreeName(worktree: Worktree | undefined) {
	if (!worktree) return "?";
	return worktree.path.split("/").filter(Boolean).at(-1) || worktree.path;
}

function activeRuns(runs: AgentRun[]) {
	return runs.filter((run) => !run.deletedAt);
}

function runLane(run: AgentRun): RunLane {
	return run.lane === "gate" || run.lane === "ship" || run.lane === "graph" ? run.lane : "task";
}

function reviewState(task: Task, runs: AgentRun[]) {
	const active = activeRuns(runs);
	const allDone = active.length > 0 && active.every((run) => run.status === "done");
	if (task.status === "done" && allDone) return "done";
	if (task.reviewInvalidatedAt && !allDone) return "need_rerun";
	if (task.status === "done") return "need_rerun";
	if (!active.length) return "waiting";
	if (allDone) return "ready";
	return "waiting";
}

function buildRunLayout<T extends LayoutRun>(runs: T[]): RunLayout<T> {
	const sorted = runs
		.map((run, index) => ({ run, index }))
		.sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt) || a.index - b.index)
		.map((item) => item.run);
	const byId = new Map(sorted.map((run) => [run.id, run]));
	const childrenByParent = new Map<string, T[]>();
	for (const run of sorted) {
		const parentId = run.parentRunId && byId.has(run.parentRunId) ? run.parentRunId : RUN_LAYOUT_ROOT;
		const children = childrenByParent.get(parentId) ?? [];
		children.push(run);
		childrenByParent.set(parentId, children);
	}

	const rawLanes = new Map<string, number>();
	const depths = new Map<string, number>();
	let nextLeafLane = 0;
	let maxDepth = 0;
	type Extent = { min: number; max: number; center: number };
	function layoutSubtree(run: T, depth: number): Extent {
		depths.set(run.id, depth);
		maxDepth = Math.max(maxDepth, depth);
		const children = childrenByParent.get(run.id) ?? [];
		if (!children.length) {
			const lane = nextLeafLane++;
			rawLanes.set(run.id, lane);
			return { min: lane, max: lane, center: lane };
		}
		const childExtents = children.map((child) => layoutSubtree(child, depth + 1));
		const min = Math.min(...childExtents.map((extent) => extent.min));
		const max = Math.max(...childExtents.map((extent) => extent.max));
		const center = (min + max) / 2;
		rawLanes.set(run.id, center);
		return { min, max, center };
	}

	const rootExtents = (childrenByParent.get(RUN_LAYOUT_ROOT) ?? []).map((run) => layoutSubtree(run, 0));
	if (!rootExtents.length)
		return { sorted, positions: new Map(), laneCount: 1, minLane: 0, maxLane: 0, maxDepth: 0 };

	const minRawLane = Math.min(...rootExtents.map((extent) => extent.min));
	const maxRawLane = Math.max(...rootExtents.map((extent) => extent.max));
	const axisLane = (minRawLane + maxRawLane) / 2;
	const positions = new Map<string, RunLayoutPosition>();
	for (const run of sorted) {
		positions.set(run.id, {
			depth: depths.get(run.id) ?? 0,
			lane: (rawLanes.get(run.id) ?? axisLane) - axisLane,
		});
	}
	return {
		sorted,
		positions,
		laneCount: Math.max(maxRawLane - minRawLane + 1, 1),
		minLane: minRawLane - axisLane,
		maxLane: maxRawLane - axisLane,
		maxDepth,
	};
}

function candidateRun(id: string, parentRunId?: string): LayoutRun {
	return {
		id,
		startedAt: RUN_CANDIDATE_STARTED_AT,
		relation: parentRunId ? "sequential" : "parallel",
		...(parentRunId ? { parentRunId } : {}),
	};
}

function graphRowHeight(layouts: RunLayout[]) {
	const minLane = Math.min(0, ...layouts.map((layout) => layout.minLane));
	const maxLane = Math.max(0, ...layouts.map((layout) => layout.maxLane));
	return Math.max(
		420,
		(maxLane - minLane) * GRAPH_RUN_LANE_GAP + GRAPH_RUN_NODE_HEIGHT + GRAPH_ROW_VERTICAL_PADDING * 2,
	);
}

function runNodePosition(centerY: number, startX: number, position: RunLayoutPosition) {
	return {
		x: startX + position.depth * GRAPH_RUN_DEPTH_GAP,
		y: centerY + position.lane * GRAPH_RUN_LANE_GAP - GRAPH_RUN_NODE_HEIGHT / 2,
	};
}

function candidateNodePosition(runPosition: { x: number; y: number }) {
	return {
		x: runPosition.x + GRAPH_ADD_RUN_CENTER_OFFSET.x,
		y: runPosition.y + GRAPH_ADD_RUN_CENTER_OFFSET.y,
	};
}

function sequentialAddRunId(taskId: string, lane: RunLane, runId: string) {
	return `add-run:${taskId}:${lane}:next:${runId}`;
}

function compactId(id: string) {
	return id.slice(0, 8);
}

function projectWorktree(project: Project, worktrees: Worktree[]) {
	const scoped = worktrees.filter((worktree) => worktree.projectId === project.id);
	return (
		scoped.find((worktree) => worktree.branch === "main") ??
		scoped.find((worktree) => worktree.path === project.rootPath) ??
		scoped.find((worktree) => worktree.branch === "master") ??
		scoped[0]
	);
}

function action(input: Omit<GraphAction, "id">): GraphAction {
	return {
		...input,
		id: `${input.command}:${JSON.stringify(input.payload)}`,
	};
}

function route(path: string) {
	return path.split("/").map((part, index) => (index === 0 ? part : encodeURIComponent(part))).join("/");
}

function projectHref(projectId: string) {
	return `/projects/${encodeURIComponent(projectId)}`;
}

function taskHref(projectId: string, taskId: string) {
	return `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
}

function runHref(projectId: string, taskId: string, runId: string) {
	return `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}`;
}

function checkpointHref(projectId: string, taskId: string) {
	return `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/checkpoint`;
}

function shipHref(projectId: string, taskId: string) {
	return `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/ship`;
}

function filesHref(projectId: string, worktreeId: string, path?: string) {
	return route(`/projects/${projectId}/worktrees/${worktreeId}/files${path ? `/${path}` : ""}`);
}

function diffsHref(projectId: string, worktreeId: string, file?: string) {
	const base = `/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/diffs`;
	return file ? `${base}?${new URLSearchParams({ file })}` : base;
}

export async function buildGraphProjection(
	projectId?: string,
	options: { history?: boolean } = {},
): Promise<GraphProjection> {
	const [allProjects, allTasks, allRuns, allWorktrees] = await Promise.all([
		listProjects(),
		listTasks(projectId ? { projectId } : {}, options.history ? { includeArchived: true, archivedOnly: true } : {}),
		db.list<AgentRun>("runs"),
		options.history ? listStoredWorktrees() : listWorktrees(),
	]);
	const projects = projectId
		? allProjects.filter((project) => project.id === projectId)
		: allProjects;
	const projectIds = new Set(projects.map((project) => project.id));
	const tasks = allTasks.filter((task) => projectIds.has(task.projectId));
	const taskIds = new Set(tasks.map((task) => task.id));
	const runs = allRuns.filter((run) => taskIds.has(run.taskId));
	const worktrees = allWorktrees.filter((worktree) => projectIds.has(worktree.projectId));
	const worktreeById = new Map(worktrees.map((worktree) => [worktree.id, worktree]));
	const tasksByProject = new Map<string, Task[]>();
	for (const task of tasks) {
		const group = tasksByProject.get(task.projectId) ?? [];
		group.push(task);
		tasksByProject.set(task.projectId, group);
	}
	const runsByTask = new Map<string, AgentRun[]>();
	for (const run of runs) {
		const group = runsByTask.get(run.taskId) ?? [];
		group.push(run);
		runsByTask.set(run.taskId, group);
	}
	const nodes: GraphProjectionNode[] = [];
	const edges: GraphProjectionEdge[] = [];
	const actions: GraphAction[] = [];
	let cursorY = GRAPH_ROW_START_Y;

	for (const project of [...projects].sort((a, b) => a.name.localeCompare(b.name))) {
		const orderedTasks = [...(tasksByProject.get(project.id) ?? [])].sort(
			(a, b) =>
				taskStatusOrder[a.status] - taskStatusOrder[b.status] ||
				b.updatedAt.localeCompare(a.updatedAt),
		);
		const rows = orderedTasks.map((task) => {
			const taskRuns = runsByTask.get(task.id) ?? [];
			const taskLaneRuns = taskRuns.filter((run) => runLane(run) === "task");
			const gateRuns = taskRuns.filter((run) => runLane(run) === "gate");
			const shipRuns = taskRuns.filter((run) => runLane(run) === "ship");
			const graphRuns = taskRuns.filter((run) => runLane(run) === "graph");
			const taskLayout = buildRunLayout(taskLaneRuns);
			const gateLayout = buildRunLayout(gateRuns);
			const shipLayout = buildRunLayout(shipRuns);
			const taskCandidateLayout = buildRunLayout([...taskLaneRuns, candidateRun(`add-run:${task.id}:parallel`)]);
			const gateCandidateLayout = buildRunLayout([...gateRuns, candidateRun(`add-run:${task.id}:gate`)]);
			const height = graphRowHeight([
				taskLayout,
				gateLayout,
				shipLayout,
				taskCandidateLayout,
				gateCandidateLayout,
			]);
			const top = cursorY;
			const y = top + height / 2;
			cursorY += height + GRAPH_ROW_GAP;
			return { task, taskRuns, taskLaneRuns, gateRuns, shipRuns, graphRuns, taskLayout, gateLayout, shipLayout, taskCandidateLayout, gateCandidateLayout, y, top, height };
		});
		const fallbackY = cursorY + 96;
		if (!rows.length) cursorY += 360 + GRAPH_ROW_GAP;
		const graphCenterY = rows.length
			? (rows[0]!.y + rows.at(-1)!.y) / 2
			: fallbackY;
		const projectNodeId = `project:${project.id}`;
		const defaultWorktree = projectWorktree(project, worktrees);
		const projectActions = [
			action({
				label: "Open project",
				command: "open_project",
				inputSchema: "open_project",
				payload: { projectId: project.id },
				href: projectHref(project.id),
			}),
		];
		if (!options.history)
			projectActions.push(
				action({
					label: "Create task",
					command: "create_task",
					inputSchema: "create_task",
					payload: { projectId: project.id },
				}),
			);
		if (!options.history && defaultWorktree)
			projectActions.push(
				action({
					label: "Open files",
					command: "open_files",
					inputSchema: "open_files",
					payload: { projectId: project.id, worktreeId: defaultWorktree.id },
					href: filesHref(project.id, defaultWorktree.id),
				}),
				action({
					label: "Open diffs",
					command: "open_diffs",
					inputSchema: "open_diffs",
					payload: { projectId: project.id, worktreeId: defaultWorktree.id },
					href: diffsHref(project.id, defaultWorktree.id),
				}),
			);
		nodes.push({
			id: projectNodeId,
			kind: "project",
			projectId: project.id,
			worktreeId: defaultWorktree?.id,
			eyebrow: "Project",
			title: project.name,
			meta: [project.rootPath],
			accent: "project",
			position: { x: GRAPH_X.project, y: graphCenterY - 70 },
			href: projectHref(project.id),
			actions: projectActions,
		});
		actions.push(...projectActions);

		for (const row of rows) {
			const { task, taskRuns, taskLaneRuns, gateRuns, shipRuns, graphRuns, taskLayout, gateLayout, shipLayout, taskCandidateLayout, gateCandidateLayout, y, top } = row;
			const activeTaskLaneRuns = activeRuns(taskLaneRuns);
			const activeGateRuns = activeRuns(gateRuns);
			const activeShipRuns = activeRuns(shipRuns);
			const activeTaskRuns = activeRuns(taskRuns);
			const taskNodeId = `task:${task.id}`;
			const worktree = task.worktreeId ? worktreeById.get(task.worktreeId) : undefined;
			const taskActions = [
				action({
					label: "Open task",
					command: "open_task",
					inputSchema: "open_task",
					payload: { projectId: project.id, taskId: task.id },
					href: taskHref(project.id, task.id),
				}),
			];
			if (!options.history)
				taskActions.push(
					action({
						label: "Update task",
						command: "update_task",
						inputSchema: "update_task",
						payload: { projectId: project.id, taskId: task.id },
					}),
					action({
						label: "Archive task",
						command: "archive_task",
						inputSchema: "archive_task",
						payload: { projectId: project.id, taskId: task.id, cleanup: true },
					}),
				);
			if (!options.history && worktree)
				taskActions.push(
					action({
						label: "Open diffs",
						command: "open_diffs",
						inputSchema: "open_diffs",
						payload: { projectId: project.id, worktreeId: worktree.id },
						href: diffsHref(project.id, worktree.id),
					}),
				);
			nodes.push({
				id: taskNodeId,
				kind: "task",
				projectId: project.id,
				taskId: task.id,
				worktreeId: task.worktreeId,
				eyebrow: "Task",
				title: task.title,
				status: task.status,
				meta: [
					`worktree: ${worktreeName(worktree)}`,
					`task lane: ${taskLaneRuns.length}`,
					`gate lane: ${gateRuns.length}`,
					`ship lane: ${shipRuns.length}`,
					...(graphRuns.length ? [`automation: ${graphRuns.length}`] : []),
				],
				position: { x: GRAPH_X.task, y: y - 64 },
				href: taskHref(project.id, task.id),
				actions: taskActions,
			});
			actions.push(...taskActions);
			edges.push({
				id: `${projectNodeId}->${taskNodeId}`,
				source: projectNodeId,
				target: taskNodeId,
				kind: "project-task",
			});

			const rowRunById = new Map(taskRuns.map((run) => [run.id, run]));
			const activeChildrenByParent = new Map<string, AgentRun[]>();
			for (const run of activeTaskRuns) {
				if (!run.parentRunId) continue;
				const children = activeChildrenByParent.get(run.parentRunId) ?? [];
				children.push(run);
				activeChildrenByParent.set(run.parentRunId, children);
			}
			const hasActiveLaneChild = (runId: string, lane: RunLane) =>
				activeChildrenByParent.get(runId)?.some((child) => runLane(child) === lane) ?? false;
			const sourceForRun = (run: AgentRun, lane: RunLane, rootNodeId: string, layout: RunLayout<AgentRun>) => {
				const parent = run.parentRunId ? rowRunById.get(run.parentRunId) : undefined;
				return parent && runLane(parent) === lane && layout.positions.has(parent.id)
					? `run:${parent.id}`
					: rootNodeId;
			};
			const maxDepthWithNextCandidates = (layout: RunLayout<AgentRun>, laneRuns: AgentRun[], lane: RunLane) => {
				let maxDepth = layout.maxDepth;
				for (const run of activeRuns(laneRuns)) {
					if (run.deletedAt || hasActiveLaneChild(run.id, lane)) continue;
					const position = layout.positions.get(run.id);
					if (position) maxDepth = Math.max(maxDepth, position.depth + 1);
				}
				return maxDepth;
			};
			const candidatePositionFromLayout = (layout: RunLayout, candidateId: string, startX: number) => {
				const position = layout.positions.get(candidateId) ?? { depth: 0, lane: 0 };
				return candidateNodePosition(runNodePosition(y, startX, position));
			};

			function pushRunLane(input: {
				layout: RunLayout<AgentRun>;
				lane: RunLane;
				rootNodeId: string;
				startX: number;
				allowNext?: boolean;
			}) {
				for (const run of input.layout.sorted) {
					const position = input.layout.positions.get(run.id) ?? { depth: 0, lane: 0 };
					const runNodeId = `run:${run.id}`;
					const runPosition = runNodePosition(y, input.startX, position);
					const runActions: GraphAction[] = [
						action({
							label: "Open run",
							command: "open_run",
							inputSchema: "open_run",
							payload: { projectId: project.id, taskId: task.id, runId: run.id },
							href: runHref(project.id, task.id, run.id),
						}),
					];
					if (!run.deletedAt && (run.status === "failed" || run.status === "cancelled"))
						runActions.push(
							action({
								label: "Continue run",
								command: "send_run_message",
								inputSchema: "send_run_message",
								payload: {
									projectId: project.id,
									taskId: task.id,
									runId: run.id,
									message: "continue",
								},
							}),
						);
					if (!run.deletedAt && run.status !== "running" && run.status !== "queued")
						runActions.push(
							action({
								label: "Retry run",
								command: "retry_run",
								inputSchema: "retry_run",
								payload: { projectId: project.id, taskId: task.id, runId: run.id },
							}),
							action({
								label: "Trash run",
								command: "delete_run",
								inputSchema: "delete_run",
								payload: { projectId: project.id, taskId: task.id, runId: run.id },
							}),
						);
					nodes.push({
						id: runNodeId,
						kind: "run",
						projectId: project.id,
						taskId: task.id,
						runId: run.id,
						worktreeId: run.worktreeId,
						relation: run.relation,
						lane: input.lane,
						eyebrow: `${input.lane === "gate" ? "Gate run" : input.lane === "ship" ? "Ship run" : "Run"} - ${compactId(run.id)}`,
						title: run.deletedAt ? "Trashed" : run.request || run.mainAgentName || "Agent run",
						status: run.status,
						meta: [new Date(run.startedAt).toLocaleString()],
						accent: [input.lane === "gate" ? "gate" : "", input.lane === "ship" ? "ship" : "", run.status === "running" ? "live" : "", run.deletedAt ? "deleted" : ""]
							.filter(Boolean)
							.join(" ") || undefined,
						position: runPosition,
						href: runHref(project.id, task.id, run.id),
						actions: runActions,
					});
					actions.push(...runActions);
					const source = sourceForRun(run, input.lane, input.rootNodeId, input.layout);
					edges.push({
						id: `${source}->${runNodeId}`,
						source,
						target: runNodeId,
						kind: input.lane === "gate" || input.lane === "ship" ? input.lane : "run",
						status: run.status,
						animated: run.status === "running",
					});
					if (!options.history && input.allowNext !== false && !run.deletedAt && !hasActiveLaneChild(run.id, input.lane)) {
						const addNextStepId = sequentialAddRunId(task.id, input.lane, run.id);
						const addNextAction = action({
							label: "New sequential run",
							command: "start_run",
							inputSchema: "start_run",
							payload: {
								projectId: project.id,
								taskId: task.id,
								relation: "sequential",
								lane: input.lane,
								parentRunId: run.id,
							},
						});
						const addNextLayout = buildRunLayout([...input.layout.sorted, candidateRun(addNextStepId, run.id)]);
						nodes.push({
							id: addNextStepId,
							kind: "add-run",
							projectId: project.id,
							taskId: task.id,
							runId: run.id,
							relation: "sequential",
							lane: input.lane,
							parentRunId: run.id,
							eyebrow: input.lane === "gate" ? "NEW GATE STEP" : "NEW SEQUENTIAL RUN",
							title: "",
							accent: "plus candidate",
							position: candidatePositionFromLayout(addNextLayout, addNextStepId, input.startX),
							actions: [addNextAction],
						});
						actions.push(addNextAction);
					}
				}
			}

			const taskFutureMaxDepth = maxDepthWithNextCandidates(taskLayout, taskLaneRuns, "task");
			pushRunLane({
				layout: taskLayout,
				lane: "task",
				rootNodeId: taskNodeId,
				startX: GRAPH_X.run,
			});

			if (!options.history) {
				const addParallelId = `add-run:${task.id}:parallel`;
				const addParallelAction = action({
					label: "New parallel run",
					command: "start_run",
					inputSchema: "start_run",
					payload: { projectId: project.id, taskId: task.id, relation: "parallel", lane: "task" },
				});
				nodes.push({
					id: addParallelId,
					kind: "add-run",
					projectId: project.id,
					taskId: task.id,
					relation: "parallel",
					lane: "task",
					eyebrow: "NEW PARALLEL RUN",
					title: "",
					accent: "plus candidate",
					position: candidatePositionFromLayout(taskCandidateLayout, addParallelId, GRAPH_X.run),
					actions: [addParallelAction],
				});
				actions.push(addParallelAction);
				edges.push({
					id: `${taskNodeId}->${addParallelId}`,
					source: taskNodeId,
					target: addParallelId,
					kind: "add",
				});
			}

			if (activeTaskRuns.length) {
				const gateNodeId = `checkpoint:${task.id}`;
				const taskLeafRuns = activeTaskLaneRuns.filter((run) => !hasActiveLaneChild(run.id, "task"));
				const state = reviewState(task, activeTaskLaneRuns);
				const gateX = Math.max(GRAPH_X.gate, GRAPH_X.run + (taskFutureMaxDepth + 1) * GRAPH_RUN_DEPTH_GAP);
				const gateStartX = Math.max(GRAPH_X.gateRun, gateX + GRAPH_RUN_DEPTH_GAP);
				const openGateAction = action({
					label: "Open gate",
					command: "open_checkpoint",
					inputSchema: "open_checkpoint",
					payload: { projectId: project.id, taskId: task.id },
					href: checkpointHref(project.id, task.id),
				});
				const markGateAction = options.history ? undefined : action({
					label: "Mark gate",
					command: "create_checkpoint",
					inputSchema: "create_checkpoint",
					payload: { projectId: project.id, taskId: task.id },
				});
				nodes.push({
					id: gateNodeId,
					kind: "checkpoint",
					projectId: project.id,
					taskId: task.id,
					worktreeId: task.worktreeId,
					eyebrow: "Gate",
					title: "Task gate",
					status: state,
					meta: [`${activeTaskLaneRuns.filter((run) => run.status === "done").length}/${activeTaskLaneRuns.length} task runs done`],
					position: { x: gateX, y: y - 64 },
					href: checkpointHref(project.id, task.id),
					actions: [openGateAction, markGateAction].filter((item): item is GraphAction => Boolean(item)),
				});
				actions.push(...[openGateAction, markGateAction].filter((item): item is GraphAction => Boolean(item)));
				if (taskLeafRuns.length) {
					for (const run of taskLeafRuns) {
						const addNextStepId = sequentialAddRunId(task.id, "task", run.id);
						edges.push(
							options.history
								? {
									id: `run:${run.id}->${gateNodeId}`,
									source: `run:${run.id}`,
									target: gateNodeId,
									kind: "checkpoint",
									status: run.status,
									animated: run.status === "running",
								}
								: {
									id: `run:${run.id}->${addNextStepId}`,
									source: `run:${run.id}`,
									target: addNextStepId,
									kind: "run",
									status: run.status,
									animated: run.status === "running",
								},
							...(options.history ? [] : [{
								id: `${addNextStepId}->${gateNodeId}`,
								source: addNextStepId,
								target: gateNodeId,
								kind: "checkpoint" as const,
							}]),
						);
					}
				} else {
					edges.push({
						id: `${taskNodeId}->${gateNodeId}`,
						source: taskNodeId,
						target: gateNodeId,
						kind: "checkpoint",
					});
				}

				if (!options.history) {
					const addGateId = `add-run:${task.id}:gate`;
					const addGateAction = action({
						label: "New gate run",
						command: "start_run",
						inputSchema: "start_run",
						payload: { projectId: project.id, taskId: task.id, relation: "parallel", lane: "gate" },
					});
					nodes.push({
						id: addGateId,
						kind: "add-run",
						projectId: project.id,
						taskId: task.id,
						relation: "parallel",
						lane: "gate",
						eyebrow: "NEW GATE RUN",
						title: "",
						accent: "plus candidate",
						position: candidatePositionFromLayout(gateCandidateLayout, addGateId, gateStartX),
						actions: [addGateAction],
					});
					actions.push(addGateAction);
					edges.push({
						id: `${gateNodeId}->${addGateId}`,
						source: gateNodeId,
						target: addGateId,
						kind: "add",
					});
				}

				const gateFutureMaxDepth = maxDepthWithNextCandidates(gateLayout, gateRuns, "gate");
				pushRunLane({
					layout: gateLayout,
					lane: "gate",
					rootNodeId: gateNodeId,
					startX: gateStartX,
				});
				const shipNodeId = `ship:${task.id}`;
				const openShipAction = action({
					label: "Open ship",
					command: "open_ship",
					inputSchema: "open_ship",
					payload: { projectId: project.id, taskId: task.id },
					href: shipHref(project.id, task.id),
				});
				const startShipAction = options.history ? undefined : action({
					label: "Start shipping",
					command: "start_shipping",
					inputSchema: "start_shipping",
					payload: { projectId: project.id, taskId: task.id },
				});
				const shipX = Math.max(GRAPH_X.ship, gateStartX + (gateFutureMaxDepth + 1) * GRAPH_RUN_DEPTH_GAP);
				const shipStatus = activeShipRuns.some((run) => run.status === "running" || run.status === "queued")
					? "shipping"
					: activeShipRuns.some((run) => run.status === "done" || run.status === "need_review")
						? "shipped"
						: activeGateRuns.every((run) => run.status === "done")
							? "ready"
							: "waiting";
				nodes.push({
					id: shipNodeId,
					kind: "ship",
					projectId: project.id,
					taskId: task.id,
					worktreeId: task.worktreeId,
					eyebrow: "Ship",
					title: "Release gate",
					status: shipStatus,
					meta: [
						activeGateRuns.length ? `${activeGateRuns.filter((run) => run.status === "done").length}/${activeGateRuns.length} gate runs done` : "no gate runs yet",
						activeShipRuns.length ? `${activeShipRuns.length} ship run${activeShipRuns.length === 1 ? "" : "s"}` : "not shipped",
					],
					position: { x: shipX, y: y - 64 },
					href: shipHref(project.id, task.id),
					actions: [openShipAction, startShipAction].filter((item): item is GraphAction => Boolean(item)),
				});
				actions.push(...[openShipAction, startShipAction].filter((item): item is GraphAction => Boolean(item)));
				const gateLeafRuns = activeGateRuns.filter((run) => !hasActiveLaneChild(run.id, "gate"));
				if (gateLeafRuns.length) {
					for (const run of gateLeafRuns) {
						const addNextStepId = sequentialAddRunId(task.id, "gate", run.id);
						edges.push(
							options.history
								? {
									id: `run:${run.id}->${shipNodeId}`,
									source: `run:${run.id}`,
									target: shipNodeId,
									kind: "ship",
									status: run.status,
									animated: run.status === "running",
								}
								: {
									id: `run:${run.id}->${addNextStepId}`,
									source: `run:${run.id}`,
									target: addNextStepId,
									kind: "gate",
									status: run.status,
									animated: run.status === "running",
								},
							...(options.history ? [] : [{
								id: `${addNextStepId}->${shipNodeId}`,
								source: addNextStepId,
								target: shipNodeId,
								kind: "ship" as const,
							}]),
						);
					}
				} else {
					edges.push({
						id: `${gateNodeId}->${shipNodeId}`,
						source: gateNodeId,
						target: shipNodeId,
						kind: "ship",
					});
				}
				pushRunLane({
					layout: shipLayout,
					lane: "ship",
					rootNodeId: shipNodeId,
					startX: shipX + GRAPH_RUN_DEPTH_GAP,
					allowNext: false,
				});
			}
		}

		if (!options.history) {
			const addTaskY = rows.length
				? rows.at(-1)!.top + rows.at(-1)!.height - 96
				: graphCenterY + 140;
			const addTaskAction = action({
				label: "New task",
				command: "create_task",
				inputSchema: "create_task",
				payload: { projectId: project.id },
			});
			nodes.push({
				id: `add-task:${project.id}`,
				kind: "add-task",
				projectId: project.id,
				eyebrow: "NEW TASK",
				title: "",
				accent: "plus candidate",
				position: { x: GRAPH_X.task, y: addTaskY },
				actions: [addTaskAction],
			});
			actions.push(addTaskAction);
			edges.push({
				id: `${projectNodeId}->add-task:${project.id}`,
				source: projectNodeId,
				target: `add-task:${project.id}`,
				kind: "add",
			});
		}
	}

	return {
		scope: projectId ? { projectId } : {},
		projects,
		tasks,
		runs,
		worktrees,
		nodes,
		edges,
		actions,
		generatedAt: new Date().toISOString(),
	};
}
