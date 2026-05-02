export const tables = [
	"projects",
	"worktrees",
	"agentProfiles",
	"tasks",
	"taskAgents",
	"annotations",
	"runs",
	"runEvents",
	"locks",
] as const;

export type TableName = (typeof tables)[number];
