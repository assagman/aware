import type { Project } from "@aware/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	BrowserRouter,
	Link,
	Outlet,
	Route,
	Routes,
	useLocation,
	useNavigate,
} from "react-router-dom";
import { apiGet } from "./api";
import { getSelectedProjectId, setSelectedProjectId } from "./selection";
import { AddProjectButton, ProjectPicker } from "../components/ProjectPicker";
import { HistoryPage } from "../pages/HistoryPage";
import { HomePage } from "../pages/HomePage";
import { ProjectPage } from "../pages/ProjectPage";
import { TaskPage } from "../pages/TaskPage";
import { RunPage } from "../pages/RunPage";
import { CheckpointPage } from "../pages/CheckpointPage";
import { ShippingPage } from "../pages/ShippingPage";
import { FilesPage } from "../pages/FilesPage";
import { DiffsPage } from "../pages/DiffsPage";
import { SettingsPage } from "../pages/SettingsPage";
import { useShellContext, type ShellContext } from "./shellContext";

function projectIdFromPath(pathname: string) {
	const match = pathname.match(/^\/projects\/([^/]+)/);
	return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function AppShell() {
	const navigate = useNavigate();
	const location = useLocation();
	const routeProjectId = projectIdFromPath(location.pathname);
	const [projectId, setProjectId] = useState(routeProjectId || getSelectedProjectId("home"));
	const [projects, setProjects] = useState<Project[]>([]);
	const [projectsLoading, setProjectsLoading] = useState(true);
	const [projectsLoaded, setProjectsLoaded] = useState(false);
	const [projectsError, setProjectsError] = useState("");

	const chooseProject = useCallback((id: string) => {
		setSelectedProjectId(id, "home");
		setProjectId(id);
		navigate(id ? `/projects/${encodeURIComponent(id)}` : "/");
	}, [navigate]);

	const reconcileProjectSelection = useCallback((rows: Project[], preferredId = routeProjectId || getSelectedProjectId("home")) => {
		const nextId = rows.some((project) => project.id === preferredId) ? preferredId : (routeProjectId || rows[0]?.id || "");
		setProjectId(nextId);
		if (nextId && nextId !== preferredId) setSelectedProjectId(nextId, "home");
	}, [routeProjectId]);

	const refreshProjects = useCallback(async (preferredId?: string) => {
		setProjectsLoading(true);
		try {
			const rows = await apiGet<Project[]>("/projects");
			setProjects(rows);
			reconcileProjectSelection(rows, (preferredId ?? routeProjectId) || getSelectedProjectId("home"));
			setProjectsError("");
		} catch (error) {
			setProjectsError(error instanceof Error ? error.message : String(error));
		} finally {
			setProjectsLoaded(true);
			setProjectsLoading(false);
		}
	}, [reconcileProjectSelection, routeProjectId]);

	useEffect(() => {
		setProjectId(routeProjectId || getSelectedProjectId("home"));
	}, [routeProjectId]);

	useEffect(() => {
		void refreshProjects();
		const syncSelection = () => setProjectId(routeProjectId || getSelectedProjectId("home"));
		const refresh = () => { void refreshProjects(); };
		window.addEventListener("aware-selection", syncSelection);
		window.addEventListener("focus", refresh);
		window.addEventListener("aware:worktrees", refresh);
		return () => {
			window.removeEventListener("aware-selection", syncSelection);
			window.removeEventListener("focus", refresh);
			window.removeEventListener("aware:worktrees", refresh);
		};
	}, [refreshProjects, routeProjectId]);

	const handleProjectCreated = useCallback((project: Project) => {
		setProjects((current) => [project, ...current.filter((candidate) => candidate.id !== project.id)]);
		setSelectedProjectId(project.id, "home");
		setProjectId(project.id);
		navigate(`/projects/${encodeURIComponent(project.id)}`);
		void refreshProjects(project.id);
	}, [navigate, refreshProjects]);

	const context = useMemo<ShellContext>(() => ({
		projects,
		projectsLoading,
		projectsLoaded,
		projectsError,
		refreshProjects,
	}), [projects, projectsError, projectsLoaded, projectsLoading, refreshProjects]);

	const inProjectScope = Boolean(routeProjectId);

	return (
		<main className="app-shell home-app-shell">
			<header className="app-header home-header">
				<Link to="/" className="home-brand home-brand-link">
					<span className="home-brand-mark">◎</span>
					<div>
						<h1>aware</h1>
						<small>Global graph → scoped routes → agent tools</small>
					</div>
				</Link>
				<div className="home-header-actions">
					{inProjectScope ? (
						<ProjectPicker value={projectId} projects={projects} loading={projectsLoading} onChange={chooseProject} onCreated={handleProjectCreated} showAdd={false} />
					) : (
						<AddProjectButton onCreated={handleProjectCreated} />
					)}
					<Link className="home-action-link" to={inProjectScope && projectId ? `/projects/${encodeURIComponent(projectId)}/history` : "/history"}>History</Link>
					<Link className="settings-button" aria-label="Settings" title="Settings" to="/settings">⚙</Link>
				</div>
			</header>
			<section className="content home-content">
				<Outlet context={context} />
			</section>
		</main>
	);
}

function HomeRoute() {
	const context = useShellContext();
	return <HomePage projectId="" {...context} />;
}

function NotFoundPage() {
	return (
		<section className="home-page route-state-page">
			<div className="home-empty">
				<h3>Route not found</h3>
				<p>URL does not match Aware graph resources.</p>
				<Link to="/">Back to graph</Link>
			</div>
		</section>
	);
}

export function AppRouter() {
	return (
		<BrowserRouter>
			<Routes>
				<Route element={<AppShell />}>
					<Route index element={<HomeRoute />} />
					<Route path="history" element={<HistoryPage />} />
					<Route path="projects/:projectId" element={<ProjectPage />} />
					<Route path="projects/:projectId/history" element={<HistoryPage />} />
					<Route path="projects/:projectId/tasks/:taskId" element={<TaskPage />} />
					<Route path="projects/:projectId/tasks/:taskId/checkpoint" element={<CheckpointPage />} />
					<Route path="projects/:projectId/tasks/:taskId/ship" element={<ShippingPage />} />
					<Route path="projects/:projectId/tasks/:taskId/runs/:runId" element={<RunPage />} />
					<Route path="projects/:projectId/worktrees/:worktreeId/files" element={<FilesPage />} />
					<Route path="projects/:projectId/worktrees/:worktreeId/files/*" element={<FilesPage />} />
					<Route path="projects/:projectId/worktrees/:worktreeId/diffs" element={<DiffsPage />} />
					<Route path="settings" element={<SettingsPage />} />
					<Route path="settings/:section" element={<SettingsPage />} />
					<Route path="*" element={<NotFoundPage />} />
				</Route>
			</Routes>
		</BrowserRouter>
	);
}
