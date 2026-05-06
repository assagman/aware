import { useNavigate, useParams } from "react-router-dom";
import { GraphRunChat } from "./HomePage";

export function AnnotationRunPage() {
	const navigate = useNavigate();
	const { projectId = "", runId = "" } = useParams();
	return (
		<GraphRunChat
			key={`${projectId}:annotation:${runId}`}
			projectId={projectId}
			runId={runId}
			onBack={() => navigate(-1)}
			onChanged={() => undefined}
		/>
	);
}
