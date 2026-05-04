import { useEffect, useState } from "react";
import { getPageState, setPageState } from "./pageState";
import { AgentsPage } from "../pages/AgentsPage";
import { FilesPage } from "../pages/FilesPage";
import { RunDetailPage } from "../pages/RunDetailPage";
import { TasksPage } from "../pages/TasksPage";

const pages = ["files", "agents", "tasks", "runs"] as const;
type Page = (typeof pages)[number];

function currentPage(): Page {
	const hash = window.location.hash.replace("#", "");
	if (pages.includes(hash as Page)) return hash as Page;
	const saved = getPageState("app", { page: "files" as Page }).page;
	return pages.includes(saved as Page) ? (saved as Page) : "files";
}

export function AppRouter() {
	const [page, setPage] = useState<Page>(currentPage());
	useEffect(() => {
		if (!window.location.hash) window.location.hash = page;
		setPageState("app", { page });
	}, [page]);
	useEffect(() => {
		const onHash = () => {
			const next = currentPage();
			setPage(next);
			setPageState("app", { page: next });
		};
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);
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
