import { lazy, Suspense } from "react";
import { Link, useParams } from "react-router-dom";
import { BusyIndicator } from "../components/BusyIndicator";

const AgentsPage = lazy(() =>
	import("./AgentsPage").then((module) => ({ default: module.AgentsPage })),
);
const SkillsPage = lazy(() =>
	import("./SkillsPage").then((module) => ({ default: module.SkillsPage })),
);

const sections = [
	{
		id: "agents",
		title: "Agents",
		subtitle: "Profiles, auth, global instructions",
	},
	{ id: "skills", title: "Skills", subtitle: "Catalog, validation, policy" },
	{ id: "providers", title: "Providers", subtitle: "Auth and model providers" },
	{
		id: "instructions",
		title: "Instructions",
		subtitle: "Global operating rules",
	},
];

export function SettingsPage() {
	const { section = "agents" } = useParams();
	const active = sections.find((item) => item.id === section) ?? sections[0]!;
	return (
		<section className="settings-page settings-modal route-state-page">
			<aside className="settings-nav-panel" aria-label="Settings sections">
				<div>
					<small>Settings</small>
					<h2>Control room</h2>
					<p>Configure app capabilities from here.</p>
				</div>
				<nav>
					{sections.map((item) => (
						<Link
							key={item.id}
							to={item.id === "agents" ? "/settings" : `/settings/${item.id}`}
							className={item.id === active.id ? "selected" : ""}
						>
							<strong>{item.title}</strong>
							<small>{item.subtitle}</small>
						</Link>
					))}
				</nav>
			</aside>
			<div className="settings-content-panel">
				<div className="home-modal-head settings-content-head">
					<div>
						<small>{active.title}</small>
						<h2>{active.subtitle}</h2>
					</div>
					<Link to="/" className="settings-close-button">
						×
					</Link>
				</div>
				{active.id === "agents" || active.id === "skills" ? (
					<Suspense
						fallback={
							<div className="settings-loading">
								<BusyIndicator label="Loading settings" />
							</div>
						}
					>
						{active.id === "agents" ? <AgentsPage /> : <SkillsPage />}
					</Suspense>
				) : (
					<div className="home-empty settings-placeholder">
						<h3>{active.title}</h3>
						<p>
							{active.subtitle}. Backing route exists; detailed editor can
							attach here.
						</p>
					</div>
				)}
			</div>
		</section>
	);
}
