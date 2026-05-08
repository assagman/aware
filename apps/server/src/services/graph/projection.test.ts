import type { AgentRun, Annotation, AnnotationTaskSuggestion, Project, Task, Worktree } from "@aware/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: {
	projects: Project[];
	tasks: Task[];
	runs: AgentRun[];
	worktrees: Worktree[];
	annotations: Annotation[];
	annotationTaskSuggestions: AnnotationTaskSuggestion[];
} = {
	projects: [],
	tasks: [],
	runs: [],
	worktrees: [],
	annotations: [],
	annotationTaskSuggestions: [],
};

vi.mock("../../db/client", () => ({
	db: {
		list: vi.fn(async (table: keyof typeof rows) => rows[table]),
	},
}));

vi.mock("../projectService", () => ({
	listProjects: vi.fn(async () => rows.projects),
	listStoredWorktrees: vi.fn(async () => rows.worktrees),
	listWorktrees: vi.fn(async () => rows.worktrees),
}));

vi.mock("../taskService", () => ({
	listTasks: vi.fn(async () => rows.tasks),
}));

const { buildGraphProjection } = await import("./projection");

const project: Project = {
	id: "project-1",
	name: "Project",
	rootPath: "/workspace/project",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const worktree: Worktree = {
	id: "worktree-1",
	projectId: project.id,
	path: "/workspace/project",
	branch: "main",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const task: Task = {
	id: "task-1",
	projectId: project.id,
	worktreeId: worktree.id,
	title: "Task",
	body: "Body",
	status: "running",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

function startedAt(index: number) {
	return `2026-01-01T00:00:0${index}.000Z`;
}

function run(input: Partial<AgentRun> & Pick<AgentRun, "id" | "startedAt">): AgentRun {
	return {
		taskId: task.id,
		worktreeId: worktree.id,
		status: "done",
		sessionId: `session-${input.id}`,
		relation: "parallel",
		lane: "task",
		...input,
	};
}

function node(projection: Awaited<ReturnType<typeof buildGraphProjection>>, id: string) {
	const found = projection.nodes.find((item) => item.id === id);
	expect(found).toBeTruthy();
	return found!;
}

function hasNode(projection: Awaited<ReturnType<typeof buildGraphProjection>>, id: string) {
	return projection.nodes.some((item) => item.id === id);
}

const runCenterY = (item: { position: { y: number } }) => item.position.y + 84;
const addRunCenterY = (item: { position: { y: number } }) => item.position.y + 29;
const runCenterX = (item: { position: { x: number } }) => item.position.x + 120;
const addRunCenterX = (item: { position: { x: number } }) => item.position.x + 31;

describe("graph projection layout", () => {
	beforeEach(() => {
		rows.projects = [project];
		rows.tasks = [task];
		rows.runs = [];
		rows.worktrees = [worktree];
		rows.annotations = [];
		rows.annotationTaskSuggestions = [];
	});

	it("centers parallel task leaves around the task axis", async () => {
		rows.runs = [
			run({ id: "run-a", startedAt: startedAt(1) }),
			run({ id: "run-b", startedAt: startedAt(2) }),
			run({ id: "run-c", startedAt: startedAt(3) }),
		];

		const projection = await buildGraphProjection(project.id);
		const taskNode = node(projection, `task:${task.id}`);
		const gateNode = node(projection, `checkpoint:${task.id}`);
		const shipNode = node(projection, `ship:${task.id}`);
		const axisY = runCenterY(taskNode);
		const runNodes = ["run-a", "run-b", "run-c"].map((id) => node(projection, `run:${id}`));
		const addParallelNode = node(projection, `add-run:${task.id}:parallel`);
		expect(taskNode.actions.map((action) => action.command)).toContain("open_annotations");
		expect(taskNode.actions.find((action) => action.command === "archive_task")?.payload).toEqual({ projectId: project.id, taskId: task.id });
		expect(runNodes[0]?.meta?.[0]).toBe(task.title);
		expect(gateNode.meta?.[0]).toBe(task.title);
		expect(node(projection, `ship:${task.id}`).meta?.[0]).toBe(task.title);

		expect(gateNode.position.y).toBe(taskNode.position.y);
		expect(shipNode.position.y).toBe(taskNode.position.y);
		expect(new Set(runNodes.map((item) => item.position.x)).size).toBe(1);
		expect(runNodes.map(runCenterY)).toEqual([axisY - 220, axisY, axisY + 220]);
		expect(addRunCenterY(addParallelNode)).toBe(axisY + 330);
		expect(addRunCenterX(addParallelNode)).toBe(runCenterX(runNodes[0]!));
	});

	it("includes active annotations in graph display", async () => {
		rows.tasks = [];
		rows.annotations = [{
			id: "annotation-1",
			projectId: project.id,
			worktreeId: worktree.id,
			kind: "range",
			filePath: "Makefile",
			startLine: 28,
			endLine: 29,
			text: "check this",
			sent: false,
			status: "processing",
			createdAt: startedAt(1),
			updatedAt: startedAt(1),
		}];
		rows.runs = [
			run({ id: "annotation-run-a", projectId: project.id, taskId: "annotation-task", lane: "annotation", annotationIds: ["annotation-1"], startedAt: startedAt(1) }),
			run({ id: "annotation-run-b", projectId: project.id, taskId: "annotation-task", lane: "annotation", annotationIds: ["annotation-1"], startedAt: startedAt(2) }),
		];

		const projection = await buildGraphProjection(project.id);
		const addTask = node(projection, `add-task:${project.id}`);
		const addTaskEdge = projection.edges.find((edge) => edge.target === `add-task:${project.id}`);

		expect(hasNode(projection, "annotation:annotation-1")).toBe(true);
		expect(hasNode(projection, "annotation-run:annotation-1:annotation-run-a")).toBe(true);
		expect(hasNode(projection, "annotation-run:annotation-1:annotation-run-b")).toBe(true);
		expect(hasNode(projection, `annotation-tasks:${project.id}`)).toBe(true);
		expect(projection.edges.some((edge) => edge.kind === "annotation" || edge.kind === "annotation-run" || edge.kind === "annotation-tasks")).toBe(true);
		expect(addTask).toBeTruthy();
		expect(addTaskEdge?.source).toBe(`annotation-tasks:${project.id}`);
	});

	it("includes task titles on annotation runs when the task exists", async () => {
		rows.annotations = [{
			id: "annotation-1",
			projectId: project.id,
			worktreeId: worktree.id,
			kind: "range",
			filePath: "Makefile",
			startLine: 28,
			endLine: 29,
			text: "check this",
			sent: false,
			status: "processing",
			createdAt: startedAt(1),
			updatedAt: startedAt(1),
		}];
		rows.runs = [
			run({ id: "annotation-run-a", projectId: project.id, taskId: task.id, lane: "annotation", annotationIds: ["annotation-1"], startedAt: startedAt(1) }),
		];

		const projection = await buildGraphProjection(project.id);

		expect(node(projection, "annotation-run:annotation-1:annotation-run-a").meta?.[0]).toBe(task.title);
	});

	it("omits archived annotations while preserving sent and processing annotations", async () => {
		rows.tasks = [];
		rows.annotations = [
			{
				id: "annotation-processing",
				projectId: project.id,
				worktreeId: worktree.id,
				kind: "line",
				filePath: "active.ts",
				startLine: 1,
				text: "processing note",
				sent: false,
				status: "processing",
				createdAt: startedAt(1),
				updatedAt: startedAt(1),
			},
			{
				id: "annotation-sent",
				projectId: project.id,
				worktreeId: worktree.id,
				kind: "line",
				filePath: "sent.ts",
				startLine: 2,
				text: "sent note",
				sent: true,
				status: "sent",
				createdAt: startedAt(2),
				updatedAt: startedAt(2),
			},
			{
				id: "annotation-archived",
				projectId: project.id,
				worktreeId: worktree.id,
				kind: "line",
				filePath: "archived.ts",
				startLine: 3,
				text: "archived note",
				sent: false,
				status: "pending",
				archivedAt: startedAt(3),
				createdAt: startedAt(3),
				updatedAt: startedAt(3),
			},
		];
		rows.runs = [
			run({ id: "run-active", projectId: project.id, taskId: "annotation-task", lane: "annotation", annotationIds: ["annotation-processing"], startedAt: startedAt(1) }),
			run({ id: "run-archived", projectId: project.id, taskId: "annotation-task", lane: "annotation", annotationIds: ["annotation-archived"], startedAt: startedAt(2) }),
		];
		rows.annotationTaskSuggestions = [
			{
				id: "suggestion-mixed",
				projectId: project.id,
				title: "Mixed",
				body: "Body",
				status: "draft",
				annotationIds: ["annotation-processing", "annotation-archived"],
				createdAt: startedAt(1),
				updatedAt: startedAt(1),
			},
			{
				id: "suggestion-archived",
				projectId: project.id,
				title: "Archived only",
				body: "Body",
				status: "draft",
				annotationIds: ["annotation-archived"],
				createdAt: startedAt(2),
				updatedAt: startedAt(2),
			},
		];

		const projection = await buildGraphProjection(project.id);
		const annotationTasks = node(projection, `annotation-tasks:${project.id}`);

		expect(projection.annotations.map((annotation) => annotation.id)).toEqual(["annotation-processing", "annotation-sent"]);
		expect(hasNode(projection, "annotation:annotation-processing")).toBe(true);
		expect(hasNode(projection, "annotation:annotation-sent")).toBe(true);
		expect(hasNode(projection, "annotation:annotation-archived")).toBe(false);
		expect(hasNode(projection, "annotation-run:annotation-archived:run-archived")).toBe(false);
		expect(projection.annotationTaskSuggestions).toHaveLength(1);
		expect(projection.annotationTaskSuggestions[0]?.annotationIds).toEqual(["annotation-processing"]);
		expect(annotationTasks.meta?.[0]).toBe("1 suggestion");
	});

	it("excludes delegated child runs from graph layout and actions", async () => {
		rows.runs = [
			run({ id: "normal-run", startedAt: startedAt(1) }),
			run({
				id: "delegated-run",
				startedAt: startedAt(2),
				parentRunId: "normal-run",
				origin: "delegate_agent",
				readOnly: true,
				affectsTaskStatus: false,
			}),
		];

		const projection = await buildGraphProjection(project.id);
		const taskNode = node(projection, `task:${task.id}`);

		expect(hasNode(projection, "run:normal-run")).toBe(true);
		expect(hasNode(projection, "run:delegated-run")).toBe(false);
		expect(taskNode.meta).toContain("task lane: 1");
		expect(projection.actions.some((action) => action.payload && typeof action.payload === "object" && "runId" in action.payload && action.payload.runId === "delegated-run")).toBe(false);
	});

	it("places sequential candidates in their future depth before the gate", async () => {
		rows.runs = [
			run({ id: "run-root", startedAt: startedAt(1) }),
			run({ id: "run-child", relation: "sequential", parentRunId: "run-root", startedAt: startedAt(2) }),
		];

		const projection = await buildGraphProjection(project.id);
		const childNode = node(projection, "run:run-child");
		const addNextNode = node(projection, `add-run:${task.id}:task:next:run-child`);
		const gateNode = node(projection, `checkpoint:${task.id}`);
		const addEdge = projection.edges.find((edge) => edge.id === `run:run-child->add-run:${task.id}:task:next:run-child`);

		expect(addRunCenterY(addNextNode)).toBe(runCenterY(childNode));
		expect(addRunCenterX(addNextNode)).toBe(1820 + 2 * 340 + 120);
		expect(gateNode.position.x).toBe(1820 + 3 * 340);
		expect(addEdge).toMatchObject({ source: "run:run-child", target: `add-run:${task.id}:task:next:run-child`, kind: "run" });
	});
});
