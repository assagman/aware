import type { Worktree } from "@aware/shared";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../app/api";
import { collapseHomePath } from "../app/path";
import { getPageState, setPageState } from "../app/pageState";
import { BusyIndicator } from "./BusyIndicator";

function worktreeName(worktree: Worktree) {
	return worktree.path.split("/").filter(Boolean).at(-1) || worktree.path;
}

export function WorktreeColumn({
	projectId,
	value,
	onChange,
	allowAll = false,
	showAdd = true,
}: {
	projectId: string;
	value: string;
	onChange: (id: string) => void;
	allowAll?: boolean;
	showAdd?: boolean;
}) {
	const stateKey = `worktree-column:${window.location.hash || "#files"}:${projectId || "none"}`;
	const initialState = getPageState(stateKey, { path: "", showAddPopover: false });
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [path, setPath] = useState(initialState.path);
	const [showAddPopover, setShowAddPopover] = useState(initialState.showAddPopover);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const filtered = useMemo(
		() => worktrees.filter((worktree) => worktree.projectId === projectId),
		[projectId, worktrees],
	);
	async function refresh() {
		setLoaded(false);
		setWorktrees(await apiGet<Worktree[]>("/worktrees"));
		setLoaded(true);
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
	useEffect(() => {
		void refresh();
		const saved = getPageState(stateKey, { path: "", showAddPopover: false });
		setPath(saved.path);
		setShowAddPopover(saved.showAddPopover);
	}, [projectId, stateKey]);
	useEffect(() => {
		if (!loaded) return;
		if (allowAll && !value) onChange("all");
		if (!allowAll && !value && filtered[0]) onChange(filtered[0].id);
		if (!allowAll && value && !filtered.some((w) => w.id === value))
			onChange(filtered[0]?.id ?? "");
	}, [allowAll, filtered, loaded, onChange, value]);
	async function addWorktree() {
		if (!projectId || !path.trim() || saving) return;
		setSaving(true);
		try {
			const worktree = await apiPost<Worktree>("/worktrees", {
				projectId,
				path: path.trim(),
			});
			setPath("");
			setShowAddPopover(false);
			setPageState(stateKey, { path: "", showAddPopover: false });
			setError("");
			await refresh();
			onChange(worktree.id);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	}
	return (
		<section className="card finder-column">
			<div className="panel-head">
				<h2>Worktrees</h2>
				{!loaded ? <BusyIndicator label="Loading" /> : null}
				{showAdd ? <button type="button" className="panel-add-button" onClick={() => { setShowAddPopover(true); setPageState(stateKey, { showAddPopover: true }); }} disabled={!projectId || saving}>+</button> : null}
			</div>
			{showAdd && showAddPopover ? (
				<div className="finder-add-popover">
					<div className="panel-head"><strong>Add worktree</strong><button type="button" onClick={() => { setShowAddPopover(false); setPageState(stateKey, { showAddPopover: false }); }}>×</button></div>
					<input
						value={path}
						onChange={(event) => { setPath(event.target.value); setPageState(stateKey, { path: event.target.value }); }}
						placeholder="/path/to/worktree"
						disabled={!projectId}
						autoFocus
					/>
					<div className="popover-actions"><button type="button" onClick={addWorktree} disabled={!projectId || !path.trim() || saving}>{saving ? "Adding…" : "Add"}</button><button type="button" onClick={() => { setShowAddPopover(false); setPageState(stateKey, { showAddPopover: false }); }} disabled={saving}>Cancel</button></div>
					{error ? <p className="error">{error}</p> : null}
				</div>
			) : null}
			<div className="finder-list">
				{allowAll ? (
					<button
						type="button"
						className={value === "all" ? "finder-row selected" : "finder-row"}
						onClick={() => onChange("all")}
					>
						<strong>All worktrees</strong>
						<small>Show every run</small>
					</button>
				) : null}
				{filtered.map((worktree) => (
					<button
						key={worktree.id}
						type="button"
						className={worktree.id === value ? "finder-row worktree-row selected" : "finder-row worktree-row"}
						onClick={() => onChange(worktree.id)}
					>
						<span className="worktree-row-title">
							<strong>{worktreeName(worktree)}</strong>
							<small>{worktree.branch || "worktree"}</small>
						</span>
						<small className="worktree-row-path">{collapseHomePath(worktree.path)}</small>
					</button>
				))}
				{projectId && !filtered.length ? (
					<p className="empty-state">No worktrees.</p>
				) : null}
				{!projectId ? <p className="empty-state">Select project.</p> : null}
			</div>

		</section>
	);
}
