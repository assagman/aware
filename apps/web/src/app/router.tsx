import { useEffect, useState } from "react";
import { getPageState, setPageState } from "./pageState";
import {
	getSelectedProjectId,
	getSelectedWorktreeId,
	setSelectedProjectId,
	setSelectedWorktreeId,
} from "./selection";
import { ProjectPicker } from "../components/ProjectPicker";
import { WorktreePicker } from "../components/WorktreePicker";
import { AgentsPage } from "../pages/AgentsPage";
import { FilesPage } from "../pages/FilesPage";
import { RunDetailPage } from "../pages/RunDetailPage";
import { TasksPage } from "../pages/TasksPage";

const pages = ["files", "agents", "tasks", "runs"] as const;
type Page = (typeof pages)[number];
type ProjectPage = "files" | "tasks" | "runs";
type WorktreePage = "files" | "runs";

function currentPage(): Page {
	const hash = window.location.hash.replace("#", "");
	if (pages.includes(hash as Page)) return hash as Page;
	const saved = getPageState("app", { page: "files" as Page }).page;
	return pages.includes(saved as Page) ? (saved as Page) : "files";
}

export function AppRouter() {
	const [page, setPage] = useState<Page>(currentPage());
	const projectPage: ProjectPage | null = page === "agents" ? null : page === "tasks" ? "tasks" : page === "runs" ? "runs" : "files";
	const worktreePage: WorktreePage | null = page === "files" || page === "runs" ? page : null;
	const [projectId, setProjectId] = useState(projectPage ? getSelectedProjectId(projectPage) : "");
	const [worktreeId, setWorktreeId] = useState(
		worktreePage ? getSelectedWorktreeId(worktreePage) || (worktreePage === "runs" ? "all" : "") : "",
	);
	useEffect(() => {
		if (!window.location.hash) window.location.hash = page;
		setPageState("app", { page });
		setProjectId(projectPage ? getSelectedProjectId(projectPage) : "");
		setWorktreeId(
			worktreePage ? getSelectedWorktreeId(worktreePage) || (worktreePage === "runs" ? "all" : "") : "",
		);
	}, [page, projectPage, worktreePage]);
	useEffect(() => {
		const onHash = () => {
			const next = currentPage();
			setPage(next);
			setPageState("app", { page: next });
		};
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);
	useEffect(() => {
		const syncSelection = () => {
			setProjectId(projectPage ? getSelectedProjectId(projectPage) : "");
			setWorktreeId(
				worktreePage ? getSelectedWorktreeId(worktreePage) || (worktreePage === "runs" ? "all" : "") : "",
			);
		};
		window.addEventListener("aware-selection", syncSelection);
		return () => window.removeEventListener("aware-selection", syncSelection);
	}, [projectPage, worktreePage]);
	function chooseProject(id: string) {
		if (!projectPage) return;
		setSelectedProjectId(id, projectPage);
		setProjectId(id);
		setWorktreeId(worktreePage === "runs" ? "all" : "");
	}
	function chooseWorktree(id: string) {
		if (!worktreePage) return;
		setSelectedWorktreeId(id, worktreePage);
		setWorktreeId(id);
	}
	return (
		<main className="app-shell">
			<header className="app-header">
				<h1>aware</h1>
				<nav className="tabs">
					<a className={page === "files" ? "active" : ""} href="#files">
						Files
					</a>
					<a className={page === "agents" ? "active" : ""} href="#agents">
						Agents
					</a>
					<a className={page === "tasks" ? "active" : ""} href="#tasks">
						Tasks
					</a>
					<a className={page === "runs" ? "active" : ""} href="#runs">
						Runs
					</a>
				</nav>
				{projectPage ? <ProjectPicker value={projectId} onChange={chooseProject} /> : <div />}
				{worktreePage ? (
					<WorktreePicker
						projectId={projectId}
						value={worktreeId}
						onChange={chooseWorktree}
						allowAll={worktreePage === "runs"}
						showAdd={worktreePage !== "runs"}
					/>
				) : null}
			</header>
			<section className="content">
				<div className="page active">
					{page === "files" ? <FilesPage /> : null}
					{page === "agents" ? <AgentsPage /> : null}
					{page === "tasks" ? <TasksPage /> : null}
					{page === "runs" ? <RunDetailPage /> : null}
				</div>
			</section>
		</main>
	);
}
