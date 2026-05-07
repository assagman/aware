import type { ToolDef } from "@flue/sdk/client";
import {
	createArtifactoryTools,
	ARTIFACTORY_TOOL_NAMES,
	type ArtifactoryToolContext,
} from "./artifactory";
import { createExaTools, EXA_RETIRED_TOOL_NAMES, EXA_TOOL_NAMES } from "./exa";
import { createGraphTools, GRAPH_TOOL_NAMES } from "./graph";
import {
	createSkillTools,
	SKILL_TOOL_NAMES,
	type SkillToolContext,
} from "./skills";
import {
	createThoughtTools,
	THOUGHT_TOOL_NAMES,
	type ThoughtToolContext,
} from "./thought";

const customToolNames = new Set<string>([
	...EXA_TOOL_NAMES,
	...GRAPH_TOOL_NAMES,
	...ARTIFACTORY_TOOL_NAMES,
	...SKILL_TOOL_NAMES,
	...THOUGHT_TOOL_NAMES,
]);

export function resolveAgentTools(
	toolNames: string[],
	context?: { artifactory?: ArtifactoryToolContext; skills?: SkillToolContext; thought?: ThoughtToolContext },
): ToolDef[] {
	const requested = new Set([
		...toolNames.filter((name) => customToolNames.has(name)),
		...(context?.artifactory ? ARTIFACTORY_TOOL_NAMES : []),
		...(context?.skills ? SKILL_TOOL_NAMES : []),
	]);
	if (!requested.size) return [];
	return [
		...createExaTools(),
		...createGraphTools(),
		...(context?.artifactory
			? createArtifactoryTools(context.artifactory)
			: []),
		...(context?.skills ? createSkillTools(context.skills) : []),
		...(context?.thought ? createThoughtTools(context.thought) : []),
	].filter((tool) => requested.has(tool.name));
}

export {
	ARTIFACTORY_TOOL_NAMES,
	EXA_RETIRED_TOOL_NAMES,
	EXA_TOOL_NAMES,
	GRAPH_TOOL_NAMES,
	SKILL_TOOL_NAMES,
	THOUGHT_TOOL_NAMES,
};
