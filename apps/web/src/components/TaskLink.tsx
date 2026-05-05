import { setSelectedProjectId, setSelectedTaskId } from "../app/selection";

export function TaskLink({
	taskId,
	projectId,
	children,
}: {
	taskId: string;
	projectId?: string | undefined;
	children?: string;
}) {
	return (
		<a
			href="#tasks"
			onClick={(event) => {
				event.stopPropagation();
				if (projectId) setSelectedProjectId(projectId, "tasks");
				setSelectedTaskId(taskId);
			}}
		>
			{children ?? `task ${taskId.slice(0, 8)}`}
		</a>
	);
}
