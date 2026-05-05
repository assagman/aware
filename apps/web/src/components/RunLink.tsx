import {
	setSelectedProjectId,
	setSelectedRunId,
	setSelectedWorktreeId,
} from "../app/selection";

export function RunLink({
	runId,
	projectId,
	children,
}: {
	runId: string;
	projectId?: string | undefined;
	children?: string;
}) {
	return (
		<a
			href="#runs"
			onClick={(event) => {
				event.stopPropagation();
				if (projectId) setSelectedProjectId(projectId, "runs");
				setSelectedWorktreeId("all", "runs");
				setSelectedRunId(runId);
			}}
		>
			{children ?? `run ${runId.slice(0, 8)}`}
		</a>
	);
}
