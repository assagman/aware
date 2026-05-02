import type { Project, Worktree } from "@agent-ide/shared";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "./api";
import {
	getSelection,
	setSelectedProjectId,
	setSelectedWorktreeId,
} from "./selection";

const ADD_PROJECT = "__add_project__";

export function TopSelection() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [selection, setSelection] = useState(getSelection());
	const selectedWorktrees = worktrees.filter(
		(w) =>
			!selection.selectedProjectId ||
			w.projectId === selection.selectedProjectId,
	);
	async function refresh() {
		const [nextProjects, nextWorktrees] = await Promise.all([
			apiGet<Project[]>("/projects"),
			apiGet<Worktree[]>("/worktrees"),
		]);
		setProjects(nextProjects);
		setWorktrees(nextWorktrees);
		setSelection(getSelection());
		return { projects: nextProjects, worktrees: nextWorktrees };
	}
	async function chooseProject(id: string) {
		if (id !== ADD_PROJECT) {
			setSelectedProjectId(id);
			return;
		}
		const path = window.prompt("Project repo path");
		if (!path?.trim()) return;
		const project = await apiPost<Project>("/projects", { path: path.trim() });
		const { worktrees } = await refresh();
		setSelectedProjectId(project.id);
		const firstWorktree = worktrees.find((w) => w.projectId === project.id);
		if (firstWorktree) setSelectedWorktreeId(firstWorktree.id);
	}
	useEffect(() => {
		void refresh();
		window.addEventListener("agent-ide-selection", refresh);
		window.addEventListener("focus", refresh);
		return () => {
			window.removeEventListener("agent-ide-selection", refresh);
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
			<label>
				Worktree{" "}
				<select
					value={selection.selectedWorktreeId}
					onChange={(e) => setSelectedWorktreeId(e.target.value)}
				>
					<option value="">select</option>
					{selectedWorktrees.map((w) => (
						<option key={w.id} value={w.id}>
							{w.branch || "worktree"} — {w.path}
						</option>
					))}
				</select>
			</label>
		</div>
	);
}
