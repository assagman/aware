export const tables = [
	"projects",
	"worktrees",
	"agentProfiles",
	"tasks",
	"annotations",
	"runs",
	"runEvents",
	"flueSessions",
	"locks",
	"authCredentials",
] as const;

export type TableName = (typeof tables)[number];
