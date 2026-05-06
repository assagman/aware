import { useParams } from "react-router-dom";
import { useShellContext } from "../app/shellContext";
import { HomePage } from "./HomePage";

export function HistoryPage() {
	const { projectId = "" } = useParams();
	const context = useShellContext();
	return <HomePage projectId={projectId} history {...context} />;
}
