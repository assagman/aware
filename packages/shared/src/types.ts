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
	systemPrompt: string;
	tools: string[];
	createdAt: string;
	updatedAt: string;
};
export type TaskStatus = "draft" | "queued" | "running" | "done" | "failed";
export type Task = {
	id: ID;
	projectId: ID;
	worktreeId: ID;
	title: string;
	body: string;
	status: TaskStatus;
	createdAt: string;
	updatedAt: string;
};
export type TaskAgent = {
	id: ID;
	taskId: ID;
	agentProfileId: ID;
	role: string;
	orderIndex: number;
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
export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type AgentRun = {
	id: ID;
	taskId: ID;
	worktreeId: ID;
	status: RunStatus;
	sessionId: string;
	mainAgentProfileId?: ID;
	mainAgentName?: string;
	mainAgentModel?: string;
	startedAt: string;
	endedAt?: string;
};
export type RunEvent = {
	id: ID;
	runId: ID;
	seq: number;
	type: string;
	payload: unknown;
	createdAt: string;
};
