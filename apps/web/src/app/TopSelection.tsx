import type { Project, Worktree } from "@agent-ide/shared";
import { useEffect, useState } from "react";
import { apiGet } from "./api";
import {
	getSelection,
	setSelectedProjectId,
	setSelectedWorktreeId,
} from "./selection";

export function TopSelection() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [selection, setSelection] = useState(getSelection());
	const selectedWorktrees = worktrees.filter(
		(w) =>
			!selection.selectedProjectId ||
			w.projectId === selection.selectedProjectId,
	);
	const refresh = () => {
		void apiGet<Project[]>("/projects").then(setProjects);
		void apiGet<Worktree[]>("/worktrees").then(setWorktrees);
		setSelection(getSelection());
	};
	useEffect(() => {
		refresh();
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
					onChange={(e) => setSelectedProjectId(e.target.value)}
				>
					<option value="">select</option>
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
