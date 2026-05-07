export const tables = [
	"projects",
	"projectSetupArtifacts",
	"worktrees",
	"agentProfiles",
	"tasks",
	"annotations",
	"annotationTaskSuggestions",
	"runs",
	"runEvents",
	"runArtifacts",
	"flueSessions",
	"locks",
	"authCredentials",
] as const;

export type TableName = (typeof tables)[number];
