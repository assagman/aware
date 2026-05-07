import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	loadSkillInputSchema,
	type AgentSkill,
	type AgentSkillCatalog,
	type AgentSkillPolicy,
} from "@aware/shared";
import type { RuntimeAgent } from "./agentRuntime/runtimeAgent";
import { listProjects } from "./projectService";

export function defaultGlobalSkillsDir() {
	return (
		process.env.AWARE_GLOBAL_SKILLS_DIR ?? join(homedir(), ".agents", "skills")
	);
}

type FrontmatterParse = {
	frontmatter: Record<string, string>;
	body: string;
	hasFrontmatter: boolean;
};

function parseFrontmatter(content: string): FrontmatterParse {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match)
		return { frontmatter: {}, body: content.trim(), hasFrontmatter: false };
	const frontmatter: Record<string, string> = {};
	for (const line of (match[1] ?? "").split("\n")) {
		const entry = line.match(/^(\w+):\s*(.+)$/);
		if (!entry?.[1] || !entry[2]) continue;
		frontmatter[entry[1]] = entry[2].trim().replace(/^['"]|['"]$/g, "");
	}
	return { frontmatter, body: (match[2] ?? "").trim(), hasFrontmatter: true };
}

async function directoryExists(path: string) {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

function riskyInternalSkill(name: string, description: string) {
	const text = `${name} ${description}`.toLowerCase();
	return /\b(ship|shipping|pull request|pr|github|codeberg|commit|merge|push)\b/.test(
		text,
	);
}

async function scanSkillDirectory(input: {
	root: string;
	scope: AgentSkill["scope"];
	projectId?: string;
	projectName?: string;
}) {
	if (!(await directoryExists(input.root))) return [];
	const entries = await readdir(input.root, { withFileTypes: true });
	const skills: AgentSkill[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const directory = entry.name;
		const skillPath = join(input.root, directory, "SKILL.md");
		const errors: string[] = [];
		const warnings: string[] = [];
		let content = "";
		try {
			content = await readFile(skillPath, "utf8");
		} catch {
			errors.push("missing SKILL.md");
		}
		const parsed = parseFrontmatter(content);
		const name = parsed.frontmatter.name || directory;
		const description = parsed.frontmatter.description || "";
		if (!parsed.hasFrontmatter) errors.push("missing YAML frontmatter");
		if (!parsed.frontmatter.name) errors.push("missing frontmatter name");
		if (!parsed.frontmatter.description)
			errors.push("missing frontmatter description");
		if (parsed.frontmatter.name && parsed.frontmatter.name !== directory)
			warnings.push("frontmatter name differs from directory");
		if (!parsed.body) warnings.push("empty skill instructions");
		const defaultDisabledForInternalAgents =
			input.scope === "global" && riskyInternalSkill(name, description);
		skills.push({
			id:
				input.scope === "global"
					? `global:${directory}`
					: `project:${input.projectId}:${directory}`,
			name,
			directory,
			description,
			scope: input.scope,
			path: skillPath,
			...(input.projectId ? { projectId: input.projectId } : {}),
			...(input.projectName ? { projectName: input.projectName } : {}),
			valid: errors.length === 0,
			enabled: errors.length === 0,
			errors,
			warnings,
			defaultDisabledForInternalAgents,
		});
	}
	return skills;
}

export async function listAgentSkills(
	input: { projectId?: string } = {},
): Promise<AgentSkillCatalog> {
	const globalSkillsPath = defaultGlobalSkillsDir();
	const projects = await listProjects();
	const selectedProjects = input.projectId
		? projects.filter((project) => project.id === input.projectId)
		: projects;
	const skills = [
		...(await scanSkillDirectory({ root: globalSkillsPath, scope: "global" })),
		...(
			await Promise.all(
				selectedProjects.map((project) =>
					scanSkillDirectory({
						root: join(project.rootPath, ".agents", "skills"),
						scope: "project",
						projectId: project.id,
						projectName: project.name,
					}),
				),
			)
		).flat(),
	];
	const seenNames = new Map<string, AgentSkill[]>();
	for (const skill of skills) {
		const key = skill.name.toLowerCase();
		seenNames.set(key, [...(seenNames.get(key) ?? []), skill]);
	}
	for (const duplicates of seenNames.values()) {
		if (duplicates.length < 2) continue;
		for (const skill of duplicates) skill.warnings.push("duplicate skill name");
	}
	return { skills, globalSkillsPath };
}

function policyReferencesSkill(reference: string, skill: AgentSkill) {
	const normalized = reference.trim().toLowerCase();
	return [skill.id, skill.name, skill.directory]
		.map((value) => value.toLowerCase())
		.includes(normalized);
}

export function skillBlockedForAgent(skill: AgentSkill, agent?: RuntimeAgent) {
	if (agent?.internal && skill.defaultDisabledForInternalAgents) return true;
	const policy: AgentSkillPolicy | undefined = agent?.skillPolicy;
	const allowed = policy?.allowed?.filter(Boolean) ?? [];
	const denied = policy?.denied?.filter(Boolean) ?? [];
	if (denied.some((reference) => policyReferencesSkill(reference, skill)))
		return true;
	if (
		allowed.length &&
		!allowed.some((reference) => policyReferencesSkill(reference, skill))
	)
		return true;
	return false;
}

export async function skillSandboxPolicy(input: {
	projectId?: string;
	agent?: RuntimeAgent;
}) {
	const catalog = await listAgentSkills(
		input.projectId ? { projectId: input.projectId } : {},
	);
	const blockedGlobalSkillDirs: string[] = [];
	const blockedWorkspaceSkillDirs: string[] = [];
	for (const skill of catalog.skills) {
		if (!skillBlockedForAgent(skill, input.agent)) continue;
		if (skill.scope === "global") blockedGlobalSkillDirs.push(skill.directory);
		else blockedWorkspaceSkillDirs.push(skill.directory);
	}
	return { blockedGlobalSkillDirs, blockedWorkspaceSkillDirs };
}

export async function loadAgentSkill(input: {
	projectId?: string;
	agent?: RuntimeAgent;
	skill: unknown;
}) {
	const parsed = loadSkillInputSchema.parse({ skill: input.skill });
	const catalog = await listAgentSkills(
		input.projectId ? { projectId: input.projectId } : {},
	);
	const matches = catalog.skills.filter(
		(skill) =>
			policyReferencesSkill(parsed.skill, skill) ||
			skill.path.endsWith(`/${parsed.skill}`),
	);
	const skill = matches.find((item) => item.scope === "project") ?? matches[0];
	if (!skill) throw new Error(`Skill not found: ${parsed.skill}`);
	if (skillBlockedForAgent(skill, input.agent))
		throw new Error(`Skill disabled by policy: ${skill.name}`);
	const content = await readFile(skill.path, "utf8");
	return {
		id: skill.id,
		name: skill.name,
		description: skill.description,
		scope: skill.scope,
		path: skill.path,
		valid: skill.valid,
		errors: skill.errors,
		warnings: skill.warnings,
		content,
	};
}
