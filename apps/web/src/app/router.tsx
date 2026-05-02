import { useEffect, useState } from "react";
import { AgentsPage } from "../pages/AgentsPage";
import { DiffsPage } from "../pages/DiffsPage";
import { FilesPage } from "../pages/FilesPage";
import { ProjectsPage } from "../pages/ProjectsPage";
import { RunDetailPage } from "../pages/RunDetailPage";
import { TasksPage } from "../pages/TasksPage";
import { WorktreesPage } from "../pages/WorktreesPage";
import { TopSelection } from "./TopSelection";

const pages = [
	"projects",
	"agents",
	"tasks",
	"runs",
	"files",
	"diffs",
] as const;
type Page = (typeof pages)[number];

function currentPage(): Page {
	const hash = window.location.hash.replace("#", "") as Page;
	return pages.includes(hash) ? hash : "projects";
}

export function AppRouter() {
	const [page, setPage] = useState<Page>(currentPage());
	useEffect(() => {
		const onHash = () => setPage(currentPage());
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);
	return (
		<main className="app-shell">
			<aside className="sidebar">
				<h1>Agent IDE</h1>
				<nav>
					<a href="#projects">Projects + Worktrees</a>
					<a href="#agents">Agents</a>
					<a href="#tasks">Tasks</a>
					<a href="#runs">Runs</a>
					<a href="#files">Files</a>
					<a href="#diffs">Diffs</a>
				</nav>
			</aside>
			<section className="content">
				<TopSelection />
				{page === "projects" ? (
					<>
						<ProjectsPage />
						<WorktreesPage />
					</>
				) : null}
				{page === "agents" ? <AgentsPage /> : null}
				{page === "tasks" ? <TasksPage /> : null}
				{page === "runs" ? <RunDetailPage /> : null}
				{page === "files" ? <FilesPage /> : null}
				{page === "diffs" ? <DiffsPage /> : null}
			</section>
		</main>
	);
}
