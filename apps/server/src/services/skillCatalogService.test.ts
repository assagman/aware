import type { Project } from "@aware/shared";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ projects: [] as Project[] }));

vi.mock("./projectService", () => ({
	listProjects: vi.fn(async () => state.projects),
}));

const { listAgentSkills, loadAgentSkill, skillSandboxPolicy } = await import(
	"./skillCatalogService"
);

const temps: string[] = [];

async function tempDir() {
	const path = await mkdtemp(join(tmpdir(), "aware-skills-"));
	temps.push(path);
	return path;
}

async function writeSkill(root: string, name: string, frontmatter = true) {
	await mkdir(join(root, name), { recursive: true });
	await writeFile(
		join(root, name, "SKILL.md"),
		frontmatter
			? `---\nname: ${name}\ndescription: ${name} skill\n---\n\nUse ${name}.\n`
			: `Use ${name}.\n`,
	);
}

afterEach(async () => {
	await Promise.all(
		temps.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
	delete process.env.AWARE_GLOBAL_SKILLS_DIR;
});

beforeEach(() => {
	state.projects = [];
});

describe("skill catalog service", () => {
	it("scans global and project skills with validation", async () => {
		const globalSkills = await tempDir();
		const projectRoot = await tempDir();
		process.env.AWARE_GLOBAL_SKILLS_DIR = globalSkills;
		state.projects = [
			{
				id: "project-1",
				name: "Project",
				rootPath: projectRoot,
				createdAt: "",
				updatedAt: "",
			},
		];
		await writeSkill(globalSkills, "commit");
		await writeSkill(join(projectRoot, ".agents", "skills"), "local", false);

		const catalog = await listAgentSkills({ projectId: "project-1" });

		expect(catalog.globalSkillsPath).toBe(globalSkills);
		expect(catalog.skills.map((skill) => skill.id).sort()).toEqual([
			"global:commit",
			"project:project-1:local",
		]);
		expect(
			catalog.skills.find((skill) => skill.id === "global:commit")
				?.defaultDisabledForInternalAgents,
		).toBe(true);
		expect(
			catalog.skills.find((skill) => skill.id === "project:project-1:local")
				?.errors,
		).toContain("missing YAML frontmatter");
	});

	it("loads project skills before global and enforces policy", async () => {
		const globalSkills = await tempDir();
		const projectRoot = await tempDir();
		process.env.AWARE_GLOBAL_SKILLS_DIR = globalSkills;
		state.projects = [
			{
				id: "project-1",
				name: "Project",
				rootPath: projectRoot,
				createdAt: "",
				updatedAt: "",
			},
		];
		await writeSkill(globalSkills, "demo");
		await writeSkill(join(projectRoot, ".agents", "skills"), "demo");
		await writeFile(
			join(projectRoot, ".agents", "skills", "demo", "SKILL.md"),
			"---\nname: demo\ndescription: Project demo\n---\n\nProject version.\n",
		);

		await expect(
			loadAgentSkill({ projectId: "project-1", skill: "demo" }),
		).resolves.toMatchObject({
			id: "project:project-1:demo",
			content: expect.stringContaining("Project version"),
		});
		await expect(
			loadAgentSkill({
				projectId: "project-1",
				skill: "demo",
				agent: {
					id: "a",
					name: "A",
					provider: "p",
					model: "p/m",
					systemPrompt: "",
					tools: [],
					skillPolicy: { denied: ["project:project-1:demo"] },
				},
			}),
		).rejects.toThrow("disabled by policy");
	});

	it("returns sandbox block lists for internal risky global skills", async () => {
		const globalSkills = await tempDir();
		process.env.AWARE_GLOBAL_SKILLS_DIR = globalSkills;
		await writeSkill(globalSkills, "ship");
		await writeSkill(globalSkills, "browser");

		const policy = await skillSandboxPolicy({
			agent: {
				id: "internal",
				name: "Shipping",
				provider: "p",
				model: "p/m",
				systemPrompt: "",
				tools: [],
				internal: true,
			},
		});

		expect(policy.blockedGlobalSkillDirs).toContain("ship");
		expect(policy.blockedGlobalSkillDirs).not.toContain("browser");
	});
});
