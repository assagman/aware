import type { Worktree } from "@aware/shared";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../app/api";
import { getSelection } from "../app/selection";

export function WorktreeSelect({
	value,
	onChange,
	allowAll = false,
	label = "Worktree",
	placeholder = "select",
	excludeDefaultBranches = false,
}: {
	value: string;
	onChange: (id: string) => void;
	allowAll?: boolean;
	label?: string;
	placeholder?: string;
	excludeDefaultBranches?: boolean;
}) {
	const [worktrees, setWorktrees] = useState<Worktree[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [projectId, setProjectId] = useState(getSelection().selectedProjectId);
	const filtered = useMemo(
		() =>
			worktrees.filter(
				(w) =>
					(!projectId || w.projectId === projectId) &&
					(!excludeDefaultBranches || !["main", "master"].includes(w.branch)),
			),
		[excludeDefaultBranches, projectId, worktrees],
	);
	async function refresh() {
		setProjectId(getSelection().selectedProjectId);
		setWorktrees(await apiGet<Worktree[]>("/worktrees"));
		setLoaded(true);
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
	useEffect(() => {
		if (!loaded) return;
		if (value && value !== "all" && !filtered.some((w) => w.id === value))
			onChange(allowAll ? "all" : "");
	}, [allowAll, filtered, loaded, onChange, value]);
	return (
		<label className="worktree-select">
			{label}{" "}
			<select value={value} onChange={(e) => onChange(e.target.value)}>
				{allowAll ? (
					<option value="all">all</option>
				) : (
					<option value="">{placeholder}</option>
				)}
				{filtered.map((w) => {
					const name = w.path.split("/").filter(Boolean).at(-1) || w.path;
					return (
						<option key={w.id} value={w.id}>
							{name} — {w.branch || "worktree"}
						</option>
					);
				})}
			</select>
		</label>
	);
}
