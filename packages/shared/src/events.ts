export type AppEvent =
	| { type: "run:event"; runId: string; event: unknown }
	| { type: "run:status"; runId: string; status: string }
	| { type: "diff:changed"; worktreeId: string };
