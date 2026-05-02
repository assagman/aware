import { useEffect, useState } from "react";
import { AgentsPage } from "../pages/AgentsPage";
import { DiffsPage } from "../pages/DiffsPage";
import { FilesPage } from "../pages/FilesPage";
import { RunDetailPage } from "../pages/RunDetailPage";
import { TasksPage } from "../pages/TasksPage";
import { TopSelection } from "./TopSelection";

const pages = ["files", "agents", "tasks", "runs", "diffs"] as const;
type Page = (typeof pages)[number];

function currentPage(): Page {
	const hash = window.location.hash.replace("#", "");
	if (hash === "project" || hash === "projects") return "files";
	return pages.includes(hash as Page) ? (hash as Page) : "files";
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
			<header className="app-header">
				<h1>Agent IDE</h1>
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
					<a className={page === "diffs" ? "active" : ""} href="#diffs">
						Diffs
					</a>
				</nav>
				<TopSelection />
			</header>
			<section className="content">
				<div className={page === "files" ? "page active" : "page"}>
					<FilesPage />
				</div>
				<div className={page === "agents" ? "page active" : "page"}>
					<AgentsPage />
				</div>
				<div className={page === "tasks" ? "page active" : "page"}>
					<TasksPage />
				</div>
				<div className={page === "runs" ? "page active" : "page"}>
					<RunDetailPage />
				</div>
				<div className={page === "diffs" ? "page active" : "page"}>
					<DiffsPage />
				</div>
			</section>
		</main>
	);
}
