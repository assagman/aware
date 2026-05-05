import type { Project } from "@aware/shared";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../app/api";
import { collapseHomePath } from "../app/path";
import { BusyIndicator } from "./BusyIndicator";
import { getPageState, setPageState } from "../app/pageState";

export function ProjectColumn({
	value,
	onChange,
	showAdd = true,
}: {
	value: string;
	onChange: (id: string) => void;
	showAdd?: boolean;
}) {
	const stateKey = `project-column:${window.location.hash || "#files"}`;
	const initialState = getPageState(stateKey, { path: "", showAddPopover: false });
	const [projects, setProjects] = useState<Project[]>([]);
	const [path, setPath] = useState(initialState.path);
	const [showAddPopover, setShowAddPopover] = useState(initialState.showAddPopover);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
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
			setShowAddPopover(false);
			setPageState(stateKey, { path: "", showAddPopover: false });
			setError("");
			await refresh();
			onChange(project.id);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	}
	return (
		<section className="card finder-column">
			<div className="panel-head">
				<h2>Projects</h2>
				{loading ? <BusyIndicator label="Loading" /> : null}
				{showAdd ? <button type="button" className="panel-add-button" onClick={() => { setShowAddPopover(true); setPageState(stateKey, { showAddPopover: true }); }} disabled={saving}>+</button> : null}
			</div>
			{showAdd && showAddPopover ? (
				<div className="finder-add-popover">
					<div className="panel-head"><strong>Add project</strong><button type="button" onClick={() => { setShowAddPopover(false); setPageState(stateKey, { showAddPopover: false }); }}>×</button></div>
					<input
						value={path}
						onChange={(event) => { setPath(event.target.value); setPageState(stateKey, { path: event.target.value }); }}
						placeholder="/path/to/git/repo"
						autoFocus
					/>
					<div className="popover-actions"><button type="button" onClick={addProject} disabled={!path.trim() || saving}>{saving ? "Adding…" : "Add"}</button><button type="button" onClick={() => { setShowAddPopover(false); setPageState(stateKey, { showAddPopover: false }); }} disabled={saving}>Cancel</button></div>
					{error ? <p className="error">{error}</p> : null}
				</div>
			) : null}
			<div className="finder-list">
				{projects.map((project) => (
					<button
						key={project.id}
						type="button"
						className={project.id === value ? "finder-row selected" : "finder-row"}
						onClick={() => onChange(project.id)}
					>
						<strong>{project.name}</strong>
						<small>{collapseHomePath(project.rootPath)}</small>
					</button>
				))}
				{!projects.length ? <p className="empty-state">No projects.</p> : null}
			</div>

		</section>
	);
}
