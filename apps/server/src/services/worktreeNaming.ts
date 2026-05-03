import type { Task } from "@aware/shared";

export const changeCategories = [
	"feat",
	"fix",
	"docs",
	"style",
	"refactor",
	"perf",
	"test",
	"build",
	"ci",
	"chore",
	"revert",
	"security",
	"deps",
	"config",
	"release",
	"hotfix",
	"migration",
	"ux",
	"api",
	"db",
	"infra",
] as const;
export type KnownChangeCategory = (typeof changeCategories)[number];
export type ChangeCategory = KnownChangeCategory | (string & {});

const categoryRules: Array<{ category: KnownChangeCategory; pattern: RegExp }> =
	[
		{ category: "hotfix", pattern: /\b(hotfix|urgent|production)\b/ },
		{
			category: "fix",
			pattern:
				/\b(fix|bug|broken|error|fail|failure|regression|crash|defect|issue)\b/,
		},
		{
			category: "security",
			pattern:
				/\b(security|secure|vulnerability|cve|xss|csrf|auth|permission|exploit|secret|token)\b/,
		},
		{
			category: "deps",
			pattern:
				/\b(deps|dependency|dependencies|package|upgrade|update package|renovate)\b/,
		},
		{
			category: "docs",
			pattern:
				/\b(docs?|document|documentation|readme|guide|manual|comment|jsdoc|typedoc)\b/,
		},
		{
			category: "test",
			pattern: /\b(tests?|spec|coverage|vitest|jest|playwright|cypress|e2e)\b/,
		},
		{
			category: "perf",
			pattern: /\b(perf|performance|speed|slow|optimi[sz]e|latency|memory)\b/,
		},
		{
			category: "refactor",
			pattern:
				/\b(refactor|restructure|rewrite|simplify|cleanup code|extract|rename)\b/,
		},
		{
			category: "style",
			pattern: /\b(style|format|lint|prettier|biome|css|styling)\b/,
		},
		{
			category: "build",
			pattern:
				/\b(build|bundle|compiler|webpack|vite|rollup|tsconfig|package manager)\b/,
		},
		{
			category: "ci",
			pattern:
				/\b(ci|workflow|github action|pipeline|release job|deploy job)\b/,
		},
		{
			category: "config",
			pattern: /\b(config|settings|env|dotenv|preferences|flags?)\b/,
		},
		{
			category: "release",
			pattern: /\b(release|version|publish|changelog|tag)\b/,
		},
		{
			category: "migration",
			pattern: /\b(migration|migrate|schema change|backfill)\b/,
		},
		{
			category: "ux",
			pattern:
				/\b(ux|ui|interface|experience|layout|interaction|accessibility|aria|screen reader|keyboard nav|locale|translation|language)\b/,
		},
		{
			category: "api",
			pattern: /\b(api|endpoint|route|request|response|contract)\b/,
		},
		{
			category: "db",
			pattern: /\b(db|database|sql|sqlite|postgres|mysql|query|index)\b/,
		},
		{
			category: "infra",
			pattern:
				/\b(infra|infrastructure|docker|container|kubernetes|terraform|hosting)\b/,
		},
		{
			category: "chore",
			pattern: /\b(chore|cleanup|maintenance|housekeeping)\b/,
		},
		{ category: "revert", pattern: /\b(revert|rollback|undo|back out)\b/ },
	];

const stopWords = new Set([
	"a",
	"an",
	"and",
	"as",
	"for",
	"in",
	"of",
	"on",
	"or",
	"the",
	"to",
	"with",
	"worktree",
	"worktrees",
]);

function explicitCategoryMatch(title: string) {
	return title.toLowerCase().match(/^([a-z][a-z0-9-]{1,20})(?:\(.+\))?:\s+/);
}

function explicitCategory(title: string) {
	return explicitCategoryMatch(title)?.[1];
}

function taskTextWithoutExplicitCategory(task: Pick<Task, "title" | "body">) {
	const match = explicitCategoryMatch(task.title);
	const title = match ? task.title.slice(match[0].length) : task.title;
	return `${title} ${task.body}`;
}

export function classifyTaskChange(task: Pick<Task, "title" | "body">) {
	const explicit = explicitCategory(task.title);
	if (explicit) return explicit;
	const text = `${task.title} ${task.body}`.toLowerCase();
	return (
		categoryRules.find((rule) => rule.pattern.test(text))?.category ?? "feat"
	);
}

export function slugifyTask(task: Pick<Task, "title" | "body">) {
	const words = taskTextWithoutExplicitCategory(task)
		.toLowerCase()
		.replace(/['’]/g, "")
		.match(/[a-z0-9]+/g)
		?.filter(
			(word) =>
				!changeCategories.includes(word as KnownChangeCategory) &&
				!stopWords.has(word),
		) ?? ["task"];
	return words.slice(0, 4).join("-") || "task";
}
