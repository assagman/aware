import type { Project, Worktree } from "@aware/shared";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../app/api";
import {
	getSelection,
	setSelectedProjectId,
	setSelectedWorktreeId,
} from "../app/selection";

export function WorktreesPage() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [items, setItems] = useState<Worktree[]>([]);
	const [projectId, setProjectIdState] = useState("");
	const [path, setPath] = useState("");
	const [error, setError] = useState("");
	const load = () => {
		void apiGet<Project[]>("/projects").then(setProjects);
		void apiGet<Worktree[]>("/worktrees").then(setItems);
		const selected = getSelection().selectedProjectId;
		if (selected) setProjectIdState(selected);
	};
	useEffect(load, []);
	async function submit() {
		if (!projectId || !path) return;
		try {
			await apiPost("/worktrees", { projectId, path });
			setPath("");
			setError("");
			load();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		}
	}
	return (
		<section id="worktrees" className="card">
			<h2>Worktrees</h2>
			<select
				value={projectId}
				onChange={(e) => {
					setProjectIdState(e.target.value);
					setSelectedProjectId(e.target.value);
				}}
			>
				<option value="">project</option>
				{projects.map((p) => (
					<option key={p.id} value={p.id}>
						{p.name}
					</option>
				))}
			</select>
			<input
				value={path}
				onChange={(e) => setPath(e.target.value)}
				placeholder="/path/to/worktree"
			/>
			<button type="button" onClick={submit}>
				Add worktree
			</button>
			{error ? <p className="error">{error}</p> : null}
			<ul>
				{items
					.filter((w) => !projectId || w.projectId === projectId)
					.map((w) => (
						<li key={w.id}>
							<button type="button" onClick={() => setSelectedWorktreeId(w.id)}>
								select
							</button>{" "}
							{w.branch} — {w.path}
						</li>
					))}
			</ul>
		</section>
	);
}
