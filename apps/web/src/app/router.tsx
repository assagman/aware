import type { Project } from "@aware/shared";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
import { BusyIndicator } from "../components/BusyIndicator";
import { useShellContext, type ShellContext } from "./shellContext";

const AnnotationRunPage = lazy(() => import("../pages/AnnotationRunPage").then((module) => ({ default: module.AnnotationRunPage })));
const AnnotationTasksPage = lazy(() => import("../pages/AnnotationTasksPage").then((module) => ({ default: module.AnnotationTasksPage })));
const AnnotationsPage = lazy(() => import("../pages/AnnotationsPage").then((module) => ({ default: module.AnnotationsPage })));
const CheckpointPage = lazy(() => import("../pages/CheckpointPage").then((module) => ({ default: module.CheckpointPage })));
const DiffsPage = lazy(() => import("../pages/DiffsPage").then((module) => ({ default: module.DiffsPage })));
const FilesPage = lazy(() => import("../pages/FilesPage").then((module) => ({ default: module.FilesPage })));
const HistoryPage = lazy(() => import("../pages/HistoryPage").then((module) => ({ default: module.HistoryPage })));
const HomePage = lazy(() => import("../pages/HomePage").then((module) => ({ default: module.HomePage })));
const ProjectPage = lazy(() => import("../pages/ProjectPage").then((module) => ({ default: module.ProjectPage })));
const RunPage = lazy(() => import("../pages/RunPage").then((module) => ({ default: module.RunPage })));
const SettingsPage = lazy(() => import("../pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const ShippingPage = lazy(() => import("../pages/ShippingPage").then((module) => ({ default: module.ShippingPage })));
const TaskPage = lazy(() => import("../pages/TaskPage").then((module) => ({ default: module.TaskPage })));

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
						<small>Projects → scoped graph → agent tools</small>
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

function SuspendedRoute({ children }: { children: ReactNode }) {
	return (
		<Suspense fallback={<div className="route-loading"><BusyIndicator label="Loading route" /></div>}>
			{children}
		</Suspense>
	);
}

function lazyRoute(children: ReactNode) {
	return <SuspendedRoute>{children}</SuspendedRoute>;
}

function HomeRoute() {
	const context = useShellContext();
	return lazyRoute(<HomePage projectId="" {...context} />);
}

function NotFoundPage() {
	return (
		<section className="home-page route-state-page">
			<div className="home-empty">
				<h3>Route not found</h3>
				<p>URL does not match Aware graph resources.</p>
				<Link to="/">Back to projects</Link>
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
					<Route path="history" element={lazyRoute(<HistoryPage />)} />
					<Route path="projects/:projectId" element={lazyRoute(<ProjectPage />)} />
					<Route path="projects/:projectId/history" element={lazyRoute(<HistoryPage />)} />
					<Route path="projects/:projectId/tasks/:taskId" element={lazyRoute(<TaskPage />)} />
					<Route path="projects/:projectId/tasks/:taskId/checkpoint" element={lazyRoute(<CheckpointPage />)} />
					<Route path="projects/:projectId/tasks/:taskId/ship" element={lazyRoute(<ShippingPage />)} />
					<Route path="projects/:projectId/tasks/:taskId/runs/:runId" element={lazyRoute(<RunPage />)} />
					<Route path="projects/:projectId/annotations" element={lazyRoute(<AnnotationsPage />)} />
					<Route path="projects/:projectId/annotation-tasks" element={lazyRoute(<AnnotationTasksPage />)} />
					<Route path="projects/:projectId/annotation-runs/:runId" element={lazyRoute(<AnnotationRunPage />)} />
					<Route path="projects/:projectId/worktrees/:worktreeId/files" element={lazyRoute(<FilesPage />)} />
					<Route path="projects/:projectId/worktrees/:worktreeId/files/*" element={lazyRoute(<FilesPage />)} />
					<Route path="projects/:projectId/worktrees/:worktreeId/diffs" element={lazyRoute(<DiffsPage />)} />
					<Route path="settings" element={lazyRoute(<SettingsPage />)} />
					<Route path="settings/:section" element={lazyRoute(<SettingsPage />)} />
					<Route path="*" element={<NotFoundPage />} />
				</Route>
			</Routes>
		</BrowserRouter>
	);
}
