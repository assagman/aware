import { useNavigate, useParams } from "react-router-dom";
import { GraphRunChat } from "./HomePage";

export function RunPage() {
	const navigate = useNavigate();
	const { projectId = "", taskId = "", runId = "" } = useParams();
	return (
		<GraphRunChat
			key={`${projectId}:${taskId}:${runId}`}
			projectId={projectId}
			taskId={taskId}
			runId={runId}
			onBack={() => navigate(-1)}
			onChanged={() => undefined}
			onMarkDoneGraph={(href) => navigate(href, { replace: true })}
		/>
	);
}
