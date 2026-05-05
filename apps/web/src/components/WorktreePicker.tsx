import type { Worktree } from "@aware/shared";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../app/api";
import { collapseHomePath } from "../app/path";
import { BusyIndicator } from "./BusyIndicator";

function worktreeName(worktree: Worktree) {
	return worktree.path.split("/").filter(Boolean).at(-1) || worktree.path;
}

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

export function WorktreePicker({
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
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [path, setPath] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const filtered = useMemo(
		() => worktrees.filter((worktree) => worktree.projectId === projectId),
		[projectId, worktrees],
	);
	const visible = useMemo(() => {
		return filtered
			.map((worktree) => ({
				worktree,
				score: fuzzyScore(`${worktreeName(worktree)} ${worktree.branch} ${worktree.path}`, query),
			}))
			.filter((row) => row.score >= 0)
			.sort((a, b) => b.score - a.score || worktreeName(a.worktree).localeCompare(worktreeName(b.worktree)))
			.map((row) => row.worktree);
	}, [filtered, query]);
	const selected = filtered.find((worktree) => worktree.id === value);
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
	}, [projectId]);
	useEffect(() => {
		if (!loaded) return;
		const hasValue = filtered.some((worktree) => worktree.id === value);
		if (allowAll && (!value || (value !== "all" && !hasValue))) onChange("all");
		if (!allowAll && !value && filtered[0]) onChange(filtered[0].id);
		if (!allowAll && value && !hasValue) onChange(filtered[0]?.id ?? "");
	}, [allowAll, filtered, loaded, onChange, value]);
	async function addWorktree() {
		if (!projectId || !path.trim() || saving) return;
		setSaving(true);
		try {
			const worktree = await apiPost<Worktree>("/worktrees", { projectId, path: path.trim() });
			setPath("");
			setError("");
			await refresh();
			onChange(worktree.id);
			setOpen(false);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	}
	return (
		<div className="fuzzy-picker worktree-picker">
			<button type="button" className="fuzzy-picker-trigger" onClick={() => setOpen((next) => !next)} disabled={!projectId}>
				<span>Worktree</span>
				<strong>{value === "all" ? "All worktrees" : selected ? `${worktreeName(selected)} — ${selected.branch || "worktree"}` : "Select worktree"}</strong>
				{!loaded ? <BusyIndicator label="" /> : null}
			</button>
			{open ? (
				<div className="fuzzy-picker-menu">
					<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="fzf worktrees..." autoFocus />
					<div className="fuzzy-picker-list">
						{allowAll ? <button type="button" className={value === "all" ? "fuzzy-picker-row selected" : "fuzzy-picker-row"} onClick={() => { onChange("all"); setOpen(false); }}><strong>All worktrees</strong><small>Show every run</small></button> : null}
						{visible.map((worktree) => (
							<button key={worktree.id} type="button" className={worktree.id === value ? "fuzzy-picker-row selected" : "fuzzy-picker-row"} onClick={() => { onChange(worktree.id); setOpen(false); }}>
								<strong>{worktreeName(worktree)} — {worktree.branch || "worktree"}</strong>
								<small>{collapseHomePath(worktree.path)}</small>
							</button>
						))}
						{projectId && !visible.length ? <p className="empty-state">No worktrees.</p> : null}
					</div>
					{showAdd ? (
						<div className="fuzzy-picker-add">
							<input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/path/to/worktree" disabled={!projectId} />
							<button type="button" onClick={addWorktree} disabled={!projectId || !path.trim() || saving}>{saving ? "Adding…" : "Add"}</button>
							{error ? <p className="error">{error}</p> : null}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
