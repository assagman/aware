import type { Project, Worktree } from "@aware/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiGet } from "../app/api";
import { HomeWorkspaceView, type WorkspaceViewState } from "./HomePage";

function lastPathSegment(path: string) {
	return path.split("/").filter(Boolean).at(-1) || path;
}

export function DiffsPage() {
	const navigate = useNavigate();
	const { projectId = "", worktreeId = "" } = useParams();
	const [searchParams, setSearchParams] = useSearchParams();
	const file = searchParams.get("file") ?? "";
	const [project, setProject] = useState<Project | null>(null);
	const [worktree, setWorktree] = useState<Worktree | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		let cancelled = false;
		setError("");
		Promise.all([
			apiGet<Project>(`/projects/${encodeURIComponent(projectId)}`),
			apiGet<Worktree>(`/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}`),
		])
			.then(([nextProject, nextWorktree]) => {
				if (cancelled) return;
				setProject(nextProject);
				setWorktree(nextWorktree);
			})
			.catch((nextError) => {
				if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
			});
		return () => { cancelled = true; };
	}, [projectId, worktreeId]);

	const view = useMemo<WorkspaceViewState>(() => ({
		mode: "diff",
		projectId,
		worktreeId,
		title: project?.name ?? "Diffs",
		subtitle: worktree?.branch || worktree?.path || lastPathSegment(worktreeId),
	}), [project?.name, projectId, worktree?.branch, worktree?.path, worktreeId]);
	const graphPath = `/projects/${encodeURIComponent(projectId)}`;
	const handleFileChange = useCallback((path: string) => {
		if (!window.location.pathname.includes(`/worktrees/${encodeURIComponent(worktreeId)}/diffs`)) return;
		if (file === path) return;
		setSearchParams(path ? { file: path } : {}, { replace: true });
	}, [file, setSearchParams, worktreeId]);

	if (error)
		return (
			<section className="home-page route-state-page">
				<div className="home-empty">
					<h3>Invalid diffs route</h3>
					<p>{error}</p>
				</div>
			</section>
		);

	return (
		<HomeWorkspaceView
			key={`diff:${projectId}:${worktreeId}`}
			view={view}
			initialFile={file}
			onBack={() => navigate(-1)}
			onGraph={() => navigate(graphPath)}
			onModeChange={() => navigate(`${graphPath}/worktrees/${encodeURIComponent(worktreeId)}/files${file ? `/${file.split("/").map(encodeURIComponent).join("/")}` : ""}`)}
			onFileChange={handleFileChange}
		/>
	);
}
