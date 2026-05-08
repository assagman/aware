import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function readPrompt(name: string) {
	const direct = join(here, name);
	const source = join(process.cwd(), "apps", "server", "src", "prompts", name);
	const path = existsSync(direct) ? direct : source;
	return readFileSync(path, "utf8").trim();
}

export function renderPromptTemplate(
	template: string,
	values: Record<string, string>,
) {
	return template.replace(/{{([a-zA-Z0-9_]+)}}/g, (match, key: string) =>
		values[key] ?? match,
	);
}

export const worktreePrompt = readPrompt("worktree.md");
export const defaultMainAgentPrompt = readPrompt("default-main-agent.md");
export const runInstructionsPrompt = readPrompt("run-instructions.md");
export const taskPromptTemplate = readPrompt("task-prompt-template.md");
export const shippingAgentPrompt = readPrompt("shipping-agent.md");
export const graphAgentPrompt = readPrompt("graph-agent.md");
export const planAgentPrompt = readPrompt("plan-agent.md");
export const exploreAgentPrompt = readPrompt("explore-agent.md");
export const reviewAgentPrompt = readPrompt("review-agent.md");
export const testAgentPrompt = readPrompt("test-agent.md");
export const annotationSentPromptTemplate = readPrompt(
	"annotation-sent-prompt-template.md",
);
export const globalAgentInstructionsBlockTemplate = readPrompt(
	"global-agent-instructions-block.md",
);
export const agentProfileInstructionsBlockTemplate = readPrompt(
	"agent-profile-instructions-block.md",
);
export const retiredDefaultAgentPromptPrefixes = readPrompt(
	"retired-default-agent-prompt-prefixes.md",
);
