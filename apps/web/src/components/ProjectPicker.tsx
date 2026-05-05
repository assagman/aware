import type { Project } from "@aware/shared";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../app/api";
import { collapseHomePath } from "../app/path";
import { getPageState, setPageState } from "../app/pageState";
import { BusyIndicator } from "./BusyIndicator";

function fuzzyScore(value: string, query: string) {
	const text = value.toLowerCase();
	const q = query.trim().toLowerCase();
	if (!q) return 0;
	let score = 0;
	let index = 0;
	for (const char of q) {
		const found = text.indexOf(char, index);
		if (found === -1) return -1;
		score += found === index ? 2 : 1;
		index = found + 1;
	}
	return score - text.length / 1000;
}

export function ProjectPicker({
	value,
	onChange,
	showAdd = true,
}: {
	value: string;
	onChange: (id: string) => void;
	showAdd?: boolean;
}) {
	const initialState = getPageState("project-picker", { path: "" });
	const [projects, setProjects] = useState<Project[]>([]);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [path, setPath] = useState(initialState.path);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const selected = projects.find((project) => project.id === value);
	const visible = useMemo(() => {
		return projects
			.map((project) => ({
				project,
				score: fuzzyScore(`${project.name} ${project.rootPath}`, query),
			}))
			.filter((row) => row.score >= 0)
			.sort((a, b) => b.score - a.score || a.project.name.localeCompare(b.project.name))
			.map((row) => row.project);
	}, [projects, query]);
	async function refresh() {
		setLoading(true);
		try {
			const rows = await apiGet<Project[]>("/projects");
			setProjects(rows);
			const hasSelected = rows.some((project) => project.id === value);
			if (!value && rows[0]) onChange(rows[0].id);
			else if (value && !hasSelected) onChange(rows[0]?.id ?? "");
		} finally {
			setLoading(false);
		}
	}
	useEffect(() => {
		void refresh();
		window.addEventListener("focus", refresh);
		window.addEventListener("aware:worktrees", refresh);
		return () => {
			window.removeEventListener("focus", refresh);
			window.removeEventListener("aware:worktrees", refresh);
		};
	}, []);
	async function addProject() {
		if (!path.trim() || saving) return;
		setSaving(true);
		try {
			const project = await apiPost<Project>("/projects", { path: path.trim() });
			setPath("");
			setPageState("project-picker", { path: "" });
			setError("");
			await refresh();
			onChange(project.id);
			setOpen(false);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	}
	return (
		<div className="fuzzy-picker project-picker">
			<button type="button" className="fuzzy-picker-trigger" onClick={() => setOpen((next) => !next)}>
				<span>Project</span>
				<strong>{selected?.name || "Select project"}</strong>
				{loading ? <BusyIndicator label="" /> : null}
			</button>
			{open ? (
				<div className="fuzzy-picker-menu">
					<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="fzf projects..." autoFocus />
					<div className="fuzzy-picker-list">
						{visible.map((project) => (
							<button key={project.id} type="button" className={project.id === value ? "fuzzy-picker-row selected" : "fuzzy-picker-row"} onClick={() => { onChange(project.id); setOpen(false); }}>
								<strong>{project.name}</strong>
								<small>{collapseHomePath(project.rootPath)}</small>
							</button>
						))}
						{!visible.length ? <p className="empty-state">No projects.</p> : null}
					</div>
					{showAdd ? (
						<div className="fuzzy-picker-add">
							<input value={path} onChange={(event) => { setPath(event.target.value); setPageState("project-picker", { path: event.target.value }); }} placeholder="/path/to/git/repo" />
							<button type="button" onClick={addProject} disabled={!path.trim() || saving}>{saving ? "Adding…" : "Add"}</button>
							{error ? <p className="error">{error}</p> : null}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
