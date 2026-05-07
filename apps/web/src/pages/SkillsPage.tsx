import type { AgentSkill, AgentSkillCatalog } from "@aware/shared";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../app/api";
import { BusyIndicator } from "../components/BusyIndicator";

function statusText(skill: AgentSkill) {
	if (!skill.valid) return "invalid";
	if (skill.defaultDisabledForInternalAgents) return "limited";
	return skill.enabled ? "enabled" : "disabled";
}

export function SkillsPage() {
	const [catalog, setCatalog] = useState<AgentSkillCatalog | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		setLoading(true);
		apiGet<AgentSkillCatalog>("/settings/skills")
			.then((data) => {
				setCatalog(data);
				setError(null);
			})
			.catch((err) =>
				setError(err instanceof Error ? err.message : "Failed to load skills"),
			)
			.finally(() => setLoading(false));
	}, []);

	const grouped = useMemo(() => {
		const skills = catalog?.skills ?? [];
		return {
			global: skills.filter((skill) => skill.scope === "global"),
			project: skills.filter((skill) => skill.scope === "project"),
		};
	}, [catalog]);

	if (loading)
		return (
			<div className="settings-loading">
				<BusyIndicator label="Loading skills" />
			</div>
		);
	if (error)
		return (
			<p role="alert" className="error settings-placeholder">
				{error}
			</p>
		);

	return (
		<section className="skills-page">
			<div className="agents-detail-head">
				<div>
					<h2>Skills</h2>
					<small>
						Global path: {catalog?.globalSkillsPath ?? "~/.agents/skills"}
					</small>
				</div>
			</div>
			<div className="agents-detail-scroll skills-scroll">
				{catalog?.skills.length ? null : (
					<div className="home-empty settings-placeholder">
						<h3>No skills found</h3>
						<p>Add skills under ~/.agents/skills or project .agents/skills.</p>
					</div>
				)}
				{(
					[
						["global", grouped.global],
						["project", grouped.project],
					] as const
				).map(([scope, skills]) =>
					skills.length ? (
						<section key={scope} className="agent-section skills-section">
							<h3>{scope === "global" ? "Global skills" : "Project skills"}</h3>
							<div className="skills-list">
								{skills.map((skill) => (
									<article
										key={skill.id}
										className={
											skill.valid ? "skill-card" : "skill-card invalid"
										}
									>
										<header>
											<div>
												<strong>{skill.name}</strong>
												<small>{skill.description || "No description"}</small>
											</div>
											<span className={`skill-status ${statusText(skill)}`}>
												{statusText(skill)}
											</span>
										</header>
										<dl>
											<dt>Directory</dt>
											<dd>{skill.directory}</dd>
											<dt>Scope</dt>
											<dd>{skill.projectName ?? skill.scope}</dd>
											<dt>Path</dt>
											<dd>{skill.path}</dd>
										</dl>
										{skill.errors.length || skill.warnings.length ? (
											<ul>
												{skill.errors.map((item) => (
													<li key={`error:${item}`}>Error: {item}</li>
												))}
												{skill.warnings.map((item) => (
													<li key={`warning:${item}`}>Warning: {item}</li>
												))}
											</ul>
										) : null}
										{skill.defaultDisabledForInternalAgents ? (
											<p>Disabled by default for internal service agents.</p>
										) : null}
									</article>
								))}
							</div>
						</section>
					) : null,
				)}
			</div>
		</section>
	);
}
