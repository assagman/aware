import { useParams } from "react-router-dom";
import { useShellContext } from "../app/shellContext";
import { HomePage } from "./HomePage";

export function ProjectPage() {
	const { projectId = "" } = useParams();
	const context = useShellContext();
	return <HomePage projectId={projectId} {...context} />;
}
