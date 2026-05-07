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

		expect(gateNode.position.y).toBe(taskNode.position.y);
		expect(shipNode.position.y).toBe(taskNode.position.y);
		expect(new Set(runNodes.map((item) => item.position.x)).size).toBe(1);
		expect(runNodes.map(runCenterY)).toEqual([axisY - 220, axisY, axisY + 220]);
		expect(addRunCenterY(addParallelNode)).toBe(axisY + 330);
		expect(addRunCenterX(addParallelNode)).toBe(runCenterX(runNodes[0]!));
	});

	it("excludes annotations from graph display", async () => {
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

		expect(projection.nodes.some((item) => item.kind === "annotation" || item.kind === "annotation-tasks")).toBe(false);
		expect(projection.edges.some((edge) => edge.kind === "annotation" || edge.kind === "annotation-run" || edge.kind === "annotation-tasks")).toBe(false);
		expect(addTask).toBeTruthy();
		expect(addTaskEdge?.source).toBe(`project:${project.id}`);
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
