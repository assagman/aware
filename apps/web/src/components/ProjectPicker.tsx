import type { Project } from "@aware/shared";
import { useMemo, useState } from "react";
import { apiPost } from "../app/api";
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

export function AddProjectButton({ onCreated }: { onCreated?: (project: Project) => void | Promise<void> }) {
	const initialState = getPageState("project-picker", { path: "" });
	const [open, setOpen] = useState(false);
	const [path, setPath] = useState(initialState.path);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	async function addProject() {
		if (!path.trim() || saving) return;
		setSaving(true);
		try {
			const project = await apiPost<Project>("/projects", { path: path.trim() });
			setPath("");
			setPageState("project-picker", { path: "" });
			setError("");
			await onCreated?.(project);
			setOpen(false);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	}
	return (
		<div className="add-project-control">
			<button type="button" className="home-action-link add-project-button" onClick={() => setOpen(true)}>Add Project</button>
			{open ? (
				<div className="home-modal-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
					<section className="home-modal add-project-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
						<div className="home-modal-head">
							<div>
								<small>Project</small>
								<h2>Add Project</h2>
							</div>
							<button type="button" onClick={() => setOpen(false)}>×</button>
						</div>
						<form className="home-form" onSubmit={(event) => { event.preventDefault(); void addProject(); }}>
							<label>
								Git repo path
								<input value={path} onChange={(event) => { setPath(event.target.value); setPageState("project-picker", { path: event.target.value }); }} placeholder="/path/to/git/repo" autoFocus />
							</label>
							{error ? <p className="error">{error}</p> : null}
							<div className="home-modal-actions">
								<button type="button" onClick={() => setOpen(false)}>Cancel</button>
								<button type="submit" disabled={!path.trim() || saving}>{saving ? "Adding…" : "Add Project"}</button>
							</div>
						</form>
					</section>
				</div>
			) : null}
		</div>
	);
}

export function ProjectPicker({
	value,
	projects,
	loading = false,
	onChange,
	onCreated,
	showAdd = true,
}: {
	value: string;
	projects: Project[];
	loading?: boolean;
	onChange: (id: string) => void;
	onCreated?: (project: Project) => void | Promise<void>;
	showAdd?: boolean;
}) {
	const initialState = getPageState("project-picker", { path: "" });
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [path, setPath] = useState(initialState.path);
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
	async function addProject() {
		if (!path.trim() || saving) return;
		setSaving(true);
		try {
			const project = await apiPost<Project>("/projects", { path: path.trim() });
			setPath("");
			setPageState("project-picker", { path: "" });
			setError("");
			if (onCreated) await onCreated(project);
			else onChange(project.id);
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
				<strong>{selected?.name || (loading && value ? "Loading project" : "Select project")}</strong>
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
