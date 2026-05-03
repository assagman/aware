import type { Project } from "@aware/shared";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../app/api";

export function ProjectsPage() {
	const [items, setItems] = useState<Project[]>([]);
	const [path, setPath] = useState("");
	const [error, setError] = useState("");
	const load = () =>
		apiGet<Project[]>("/projects").then(setItems).catch(console.error);
	useEffect(() => {
		void load();
	}, []);
	async function submit() {
		if (!path) return;
		try {
			await apiPost("/projects", { path });
			setPath("");
			setError("");
			load();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		}
	}
	return (
		<section id="projects" className="card">
			<h2>Projects</h2>
			<input
				value={path}
				onChange={(e) => setPath(e.target.value)}
				placeholder="/path/to/git/repo"
			/>
			<button type="button" onClick={submit}>
				Add project
			</button>
			{error ? <p className="error">{error}</p> : null}
			<ul>
				{items.map((p) => (
					<li key={p.id}>
						{p.name} — {p.rootPath}
					</li>
				))}
			</ul>
		</section>
	);
}
