export type ID = string;

export type Project = {
	id: ID;
	name: string;
	rootPath: string;
	createdAt: string;
	updatedAt: string;
};
export type ProjectSetupArtifact = {
	id: ID;
	projectId: ID;
	signature: string;
	commands: { command: string; args: string[]; reason: string }[];
	createdAt: string;
	updatedAt: string;
};
export type Worktree = {
	id: ID;
	projectId: ID;
	path: string;
	branch: string;
	baseBranch?: string;
	deletedAt?: string;
	createdAt: string;
	updatedAt: string;
};
export type AgentSkillPolicy = {
	allowed?: string[];
	denied?: string[];
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
	skillPolicy?: AgentSkillPolicy;
	createdAt: string;
	updatedAt: string;
};
export type AgentSkillScope = "global" | "project";
export type AgentSkill = {
	id: ID;
	name: string;
	directory: string;
	description: string;
	scope: AgentSkillScope;
	path: string;
	projectId?: ID;
	projectName?: string;
	enabled: boolean;
	valid: boolean;
	errors: string[];
	warnings: string[];
	defaultDisabledForInternalAgents: boolean;
};
export type AgentSkillCatalog = {
	skills: AgentSkill[];
	globalSkillsPath: string;
};
export type TaskStatus =
	| "draft"
	| "queued"
	| "running"
	| "need_review"
	| "done"
	| "failed";
export type TaskSource =
	| "user"
	| "direct-chat"
	| "annotation-run"
	| "annotation-tasks";
export type Task = {
	id: ID;
	projectId: ID;
	worktreeId?: ID;
	title: string;
	body: string;
	status: TaskStatus;
	source?: TaskSource;
	annotationIds?: ID[];
	annotationTaskSuggestionId?: ID;
	sourceAnnotationIds?: ID[];
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
	context?: string;
	selectedText?: string;
	sent: boolean;
	status?: "pending" | "processing" | "sent" | "archived";
	runId?: ID;
	archivedAt?: string;
	createdAt: string;
	updatedAt: string;
};
export type AnnotationSuggestionTargetKind = "task" | "run";
export type AnnotationTaskSuggestion = {
	id: ID;
	projectId: ID;
	title: string;
	body: string;
	status: "draft" | "approved" | "creating" | "created" | "rejected";
	targetKind?: AnnotationSuggestionTargetKind;
	sourceRunId?: ID;
	annotationIds?: ID[];
	worktreeId?: ID;
	taskId?: ID;
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
export type RunLane =
	| "task"
	| "gate"
	| "ship"
	| "graph"
	| "annotation"
	| "annotation-tasks";
export type AgentRun = {
	id: ID;
	taskId: ID;
	projectId?: ID;
	worktreeId: ID;
	status: RunStatus;
	sessionId: string;
	annotationIds?: ID[];
	relation?: RunRelation;
	lane?: RunLane;
	parentRunId?: ID;
	request?: string;
	mainAgentProfileId?: ID;
	mainAgentName?: string;
	mainAgentModel?: string;
	readOnly?: boolean;
	affectsTaskStatus?: boolean;
	origin?: "delegate_agent";
	delegateRole?: string;
	delegateDescription?: string;
	delegateToolCallId?: string;
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
export type RunArtifactKind = "session_report" | "thought_graph";
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
	| "archive_task"
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
	| "open_diffs"
	| "open_annotations"
	| "open_annotation_tasks";

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
	| "annotation"
	| "annotation-tasks"
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
	annotationId?: ID | undefined;
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
	kind:
		| "project-task"
		| "annotation"
		| "annotation-run"
		| "annotation-tasks"
		| "run"
		| "add"
		| "checkpoint"
		| "gate"
		| "ship"
		| "review";
	status?: string;
	animated?: boolean;
};

export type GraphProjection = {
	scope: { projectId?: ID };
	projects: Project[];
	annotations: Annotation[];
	annotationTaskSuggestions: AnnotationTaskSuggestion[];
	tasks: Task[];
	runs: AgentRun[];
	worktrees: Worktree[];
	nodes: GraphProjectionNode[];
	edges: GraphProjectionEdge[];
	actions: GraphAction[];
	generatedAt: string;
};
