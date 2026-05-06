export type ID = string;

export type Project = {
	id: ID;
	name: string;
	rootPath: string;
	createdAt: string;
	updatedAt: string;
};
export type Worktree = {
	id: ID;
	projectId: ID;
	path: string;
	branch: string;
	baseBranch?: string;
	createdAt: string;
	updatedAt: string;
};
export type AgentProfile = {
	id: ID;
	name: string;
	provider: string;
	model: string;
	thinking?: string;
	temperature?: number;
	systemPrompt: string;
	tools: string[];
	createdAt: string;
	updatedAt: string;
};
export type TaskStatus = "draft" | "queued" | "running" | "need_review" | "done" | "failed";
export type Task = {
	id: ID;
	projectId: ID;
	worktreeId?: ID;
	title: string;
	body: string;
	status: TaskStatus;
	archivedAt?: string;
	deletedAt?: string;
	reviewInvalidatedAt?: string;
	createdAt: string;
	updatedAt: string;
};
export type AnnotationKind = "file" | "line" | "range" | "diff";
export type Annotation = {
	id: ID;
	projectId: ID;
	worktreeId: ID;
	taskId?: ID;
	kind: AnnotationKind;
	filePath?: string;
	side?: "old" | "new" | "additions" | "deletions";
	startLine?: number;
	endLine?: number;
	text: string;
	sent: boolean;
	status?: "pending" | "processing" | "sent";
	runId?: ID;
	createdAt: string;
	updatedAt: string;
};
export type RunStatus =
	| "queued"
	| "running"
	| "need_review"
	| "done"
	| "failed"
	| "cancelled";
export type RunRelation = "parallel" | "sequential";
export type RunLane = "task" | "gate" | "ship" | "graph";
export type AgentRun = {
	id: ID;
	taskId: ID;
	worktreeId: ID;
	status: RunStatus;
	sessionId: string;
	relation?: RunRelation;
	lane?: RunLane;
	parentRunId?: ID;
	request?: string;
	mainAgentProfileId?: ID;
	mainAgentName?: string;
	mainAgentModel?: string;
	startedAt: string;
	endedAt?: string;
	deletedAt?: string;
};
export type RunEvent = {
	id: ID;
	runId: ID;
	seq: number;
	type: string;
	payload: unknown;
	createdAt: string;
};
export type RunArtifactKind = "session_report";
export type RunArtifact = {
	id: ID;
	projectId: ID;
	taskId: ID;
	runId: ID;
	worktreeId: ID;
	kind: RunArtifactKind;
	turnSeq: number;
	lane?: RunLane;
	parentRunId?: ID;
	title: string;
	body: string;
	metadata?: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
};

export type GraphCommandName =
	| "create_project"
	| "create_task"
	| "update_task"
	| "mark_task_done"
	| "start_run"
	| "send_run_message"
	| "retry_run"
	| "delete_run"
	| "create_checkpoint"
	| "start_shipping"
	| "open_project"
	| "open_checkpoint"
	| "open_ship"
	| "open_task"
	| "open_run"
	| "open_files"
	| "open_diffs";

export type GraphAction = {
	id: ID;
	label: string;
	command: GraphCommandName;
	inputSchema: string;
	payload: Record<string, unknown>;
	href?: string;
};

export type GraphProjectionNodeKind =
	| "project"
	| "task"
	| "run"
	| "add-task"
	| "add-run"
	| "checkpoint"
	| "ship"
	| "review";

export type GraphProjectionNode = {
	id: ID;
	kind: GraphProjectionNodeKind;
	projectId?: ID | undefined;
	taskId?: ID | undefined;
	runId?: ID | undefined;
	worktreeId?: ID | undefined;
	relation?: RunRelation | undefined;
	lane?: RunLane | undefined;
	parentRunId?: ID | undefined;
	eyebrow: string;
	title: string;
	status?: string | undefined;
	meta?: string[] | undefined;
	accent?: string | undefined;
	position: { x: number; y: number };
	href?: string | undefined;
	actions: GraphAction[];
};

export type GraphProjectionEdge = {
	id: ID;
	source: ID;
	target: ID;
	kind: "project-task" | "run" | "add" | "checkpoint" | "gate" | "ship" | "review";
	status?: string;
	animated?: boolean;
};

export type GraphProjection = {
	scope: { projectId?: ID };
	projects: Project[];
	tasks: Task[];
	runs: AgentRun[];
	worktrees: Worktree[];
	nodes: GraphProjectionNode[];
	edges: GraphProjectionEdge[];
	actions: GraphAction[];
	generatedAt: string;
};
