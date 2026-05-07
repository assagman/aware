import type {
	Annotation,
	AnnotationTaskSuggestion,
	Project,
	Task,
	Worktree,
} from "@aware/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	suggestions: [] as AnnotationTaskSuggestion[],
	annotations: [] as Annotation[],
	worktrees: [] as Worktree[],
	tasks: [] as Task[],
	dbUpdateCalls: [] as Array<{ table: string; id: string; patch: unknown }>,
	markSuggestionCalls: [] as Array<{ ids: string[]; patch: unknown }>,
	updateAnnotationCalls: [] as Array<{ id: string; patch: unknown }>,
}));

class MockRouteValidationError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

const stamp = "2026-01-01T00:00:00.000Z";
const project: Project = {
	id: "project-1",
	name: "Project",
	rootPath: "/workspace/project",
	createdAt: stamp,
	updatedAt: stamp,
};
const defaultWorktree: Worktree = {
	id: "worktree-main",
	projectId: project.id,
	path: project.rootPath,
	branch: "main",
	createdAt: stamp,
	updatedAt: stamp,
};
const customWorktree: Worktree = {
	id: "worktree-custom",
	projectId: project.id,
	path: "/workspace/project-custom",
	branch: "task/custom",
	createdAt: stamp,
	updatedAt: stamp,
};
const task: Task = {
	id: "task-1",
	projectId: project.id,
	worktreeId: customWorktree.id,
	title: "Task",
	body: "Body",
	status: "draft",
	createdAt: stamp,
	updatedAt: stamp,
};

function suggestion(input: Partial<AnnotationTaskSuggestion> = {}): AnnotationTaskSuggestion {
	return {
		id: "suggestion-1",
		projectId: project.id,
		title: "Investigate annotation",
		body: "Use annotation context.",
		status: "draft",
		createdAt: stamp,
		updatedAt: stamp,
		...input,
	};
}

function annotation(input: Partial<Annotation> = {}): Annotation {
	return {
		id: "annotation-1",
		projectId: project.id,
		worktreeId: customWorktree.id,
		kind: "file",
		filePath: "src/file.ts",
		text: "note",
		sent: false,
		status: "pending",
		createdAt: stamp,
		updatedAt: stamp,
		...input,
	};
}

vi.mock("../db/client", () => ({
	db: {
		list: vi.fn(async () => []),
		insert: vi.fn(async (_table: string, row: { id: string }) => row),
		update: vi.fn(async (table: string, id: string, patch: unknown) => {
			state.dbUpdateCalls.push({ table, id, patch });
			if (table !== "annotationTaskSuggestions") return null;
			const index = state.suggestions.findIndex((item) => item.id === id);
			if (index === -1) return null;
			const updated = { ...state.suggestions[index]!, ...(patch as object), id } as AnnotationTaskSuggestion;
			state.suggestions[index] = updated;
			return updated;
		}),
	},
}));

vi.mock("./graph/validation", () => ({
	RouteValidationError: MockRouteValidationError,
	getProjectOrThrow: vi.fn(async (projectId: string) => {
		if (projectId !== project.id) throw new MockRouteValidationError("missing project", 404);
		return project;
	}),
	getWorktreeInProjectOrThrow: vi.fn(async (projectId: string, worktreeId: string) => {
		const worktree = state.worktrees.find((item) => item.projectId === projectId && item.id === worktreeId);
		if (!worktree) throw new MockRouteValidationError("missing worktree", 404);
		return worktree;
	}),
	getTaskInProjectOrThrow: vi.fn(async (projectId: string, taskId: string) => {
		const found = state.tasks.find((item) => item.projectId === projectId && item.id === taskId);
		if (!found) throw new MockRouteValidationError("missing task", 404);
		return found;
	}),
}));

vi.mock("./projectService", () => ({
	addWorktree: vi.fn(),
	listWorktrees: vi.fn(async () => state.worktrees),
}));

vi.mock("./taskService", () => ({
	createTask: vi.fn(async (input: Partial<Task>) => {
		const created = suggestionTask(input);
		state.tasks.push(created);
		return created;
	}),
	listTasks: vi.fn(async (filter: Partial<Pick<Task, "projectId" | "worktreeId">> = {}) =>
		state.tasks.filter((item) =>
			(!filter.projectId || item.projectId === filter.projectId) &&
			(!filter.worktreeId || item.worktreeId === filter.worktreeId),
		),
	),
}));

function suggestionTask(input: Partial<Task>): Task {
	return {
		id: input.id ?? "created-task",
		projectId: input.projectId ?? project.id,
		title: input.title ?? "Created task",
		body: input.body ?? "",
		status: "draft",
		...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
		...(input.source ? { source: input.source } : {}),
		...(input.annotationTaskSuggestionId ? { annotationTaskSuggestionId: input.annotationTaskSuggestionId } : {}),
		...(input.sourceAnnotationIds?.length ? { sourceAnnotationIds: input.sourceAnnotationIds } : {}),
		createdAt: stamp,
		updatedAt: stamp,
	};
}

vi.mock("./annotationService", () => ({
	annotationLocation: vi.fn(() => "src/file.ts"),
	getAnnotationInProject: vi.fn(async (projectId: string, annotationId: string) =>
		state.annotations.find((item) => item.projectId === projectId && item.id === annotationId),
	),
	getAnnotationTaskSuggestion: vi.fn(async (projectId: string, suggestionId: string) =>
		state.suggestions.find((item) => item.projectId === projectId && item.id === suggestionId),
	),
	listAnnotations: vi.fn(async () => state.annotations),
	markAnnotationsProcessing: vi.fn(),
	markAnnotationTaskSuggestions: vi.fn(async (ids: string[], patch: Partial<AnnotationTaskSuggestion>) => {
		state.markSuggestionCalls.push({ ids, patch });
		return ids.map((id) => {
			const index = state.suggestions.findIndex((item) => item.id === id);
			if (index === -1) return null;
			const updated = { ...state.suggestions[index]!, ...patch, id } as AnnotationTaskSuggestion;
			state.suggestions[index] = updated;
			return updated;
		});
	}),
	saveAnnotationTaskSuggestions: vi.fn(async () => []),
	serializeAnnotations: vi.fn(() => "annotations"),
	updateAnnotation: vi.fn(async (id: string, patch: Partial<Annotation>) => {
		state.updateAnnotationCalls.push({ id, patch });
		return state.annotations.find((item) => item.id === id) ?? null;
	}),
}));

vi.mock("./graph/commands", () => ({
	startRunCommand: vi.fn(async () => ({
		id: "run-1",
		taskId: task.id,
		projectId: project.id,
		worktreeId: customWorktree.id,
		status: "running",
		sessionId: "session-1",
		startedAt: stamp,
	})),
}));
vi.mock("./agentRuntime/flueRuntime", () => ({ flueRuntime: { startChat: vi.fn(), startRun: vi.fn() } }));
vi.mock("./gitService", () => ({ git: vi.fn(), worktreeRoot: vi.fn() }));
vi.mock("./graphAgentService", () => ({ listGraphAgentsForRun: vi.fn(async () => []) }));
vi.mock("./shippingAgentService", () => ({ listMainAgentsForRun: vi.fn(async () => []) }));
vi.mock("./workspaceConvention", () => ({ worktreePathForBranch: vi.fn(() => "/tmp/worktree") }));
vi.mock("./worktreeLock", () => ({ withQueuedLock: vi.fn(async (_key: string, fn: () => unknown) => fn()) }));

const { approveAnnotationSuggestion, rejectAnnotationSuggestion } = await import("./annotationWorkflowService");

describe("annotation workflow approvals", () => {
	beforeEach(() => {
		state.suggestions = [];
		state.annotations = [];
		state.worktrees = [defaultWorktree, customWorktree];
		state.tasks = [task];
		state.dbUpdateCalls = [];
		state.markSuggestionCalls = [];
		state.updateAnnotationCalls = [];
	});

	it("does not mark run suggestion creating when target validation fails", async () => {
		state.suggestions = [suggestion({ targetKind: "run", annotationIds: ["annotation-1"] })];
		state.annotations = [annotation({ worktreeId: "missing-worktree" })];

		await expect(approveAnnotationSuggestion({ projectId: project.id, suggestionId: "suggestion-1" }))
			.rejects.toMatchObject({ status: 404 });

		expect(state.suggestions[0]?.status).toBe("draft");
		expect(state.dbUpdateCalls).toEqual([]);
		expect(state.markSuggestionCalls).toEqual([]);
	});

	it("rejects created suggestion without mutating status", async () => {
		state.suggestions = [suggestion({ status: "created", taskId: task.id })];

		await expect(rejectAnnotationSuggestion(project.id, "suggestion-1"))
			.rejects.toMatchObject({ status: 409 });

		expect(state.suggestions[0]?.status).toBe("created");
		expect(state.markSuggestionCalls).toEqual([]);
	});
});
