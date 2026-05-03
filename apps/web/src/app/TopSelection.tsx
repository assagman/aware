import type { Project } from "@aware/shared";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "./api";
import { getSelection, setSelectedProjectId } from "./selection";

const ADD_PROJECT = "__add_project__";

export function TopSelection() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [selection, setSelection] = useState(getSelection());
	async function refresh() {
		const nextProjects = await apiGet<Project[]>("/projects");
		setProjects(nextProjects);
		setSelection(getSelection());
		return { projects: nextProjects };
	}
	async function chooseProject(id: string) {
		if (id !== ADD_PROJECT) {
			setSelectedProjectId(id);
			return;
		}
		const path = window.prompt("Project repo path");
		if (!path?.trim()) return;
		const project = await apiPost<Project>("/projects", { path: path.trim() });
		await refresh();
		setSelectedProjectId(project.id);
	}
	useEffect(() => {
		void refresh();
		window.addEventListener("aware-selection", refresh);
		window.addEventListener("focus", refresh);
		return () => {
			window.removeEventListener("aware-selection", refresh);
			window.removeEventListener("focus", refresh);
		};
	}, []);
	return (
		<div className="top-select">
			<label>
				Project{" "}
				<select
					value={selection.selectedProjectId}
					onChange={(e) => void chooseProject(e.target.value)}
				>
					<option value="">select</option>
					<option value={ADD_PROJECT}>+ add project…</option>
					{projects.map((p) => (
						<option key={p.id} value={p.id}>
							{p.name}
						</option>
					))}
				</select>
			</label>
		</div>
	);
}
