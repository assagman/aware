import type { Project } from "@aware/shared";
import { useOutletContext } from "react-router-dom";

export type ShellContext = {
	projects: Project[];
	projectsLoading: boolean;
	projectsLoaded: boolean;
	projectsError: string;
	refreshProjects: (preferredId?: string) => Promise<void>;
};

export function useShellContext() {
	return useOutletContext<ShellContext>();
}
