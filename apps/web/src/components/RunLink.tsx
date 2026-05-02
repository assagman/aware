import { setSelectedRunId } from "../app/selection";

export function RunLink({
	runId,
	children,
}: {
	runId: string;
	children?: string;
}) {
	return (
		<a href="#runs" onClick={() => setSelectedRunId(runId)}>
			{children ?? `run ${runId.slice(0, 8)}`}
		</a>
	);
}
