import type { RuntimeAgent } from "./agentRuntime/runtimeAgent";
import { ARTIFACTORY_TOOL_NAMES, GRAPH_TOOL_NAMES } from "../flue/tools";
import { graphAgentPrompt } from "../prompts";
import { listAgentProfilesForRun } from "./agentProfileService";

export const graphAgent = {
	name: "Graph",
	prompt: graphAgentPrompt,
};

function graphRuntimeAgent(base: RuntimeAgent): RuntimeAgent {
	return {
		id: "internal:graph-agent",
		name: "Graph Agent",
		description: "Internal service agent for project graph orchestration: task runs, gate runs, checkpoints, and ship-prep evidence.",
		roleName: "graph-agent",
		provider: base.provider,
		model: base.model,
		...(base.thinking ? { thinking: base.thinking } : {}),
		...(base.temperature !== undefined ? { temperature: base.temperature } : {}),
		systemPrompt: graphAgent.prompt,
		tools: [...GRAPH_TOOL_NAMES, ...ARTIFACTORY_TOOL_NAMES],
		internal: true,
		allowedToolNames: [...GRAPH_TOOL_NAMES, ...ARTIFACTORY_TOOL_NAMES],
		skillsEnabled: false,
		toolExecution: "sequential",
	};
}

export async function listGraphAgentsForRun(): Promise<RuntimeAgent[]> {
	const agents = await listAgentProfilesForRun();
	const base = agents[0];
	if (!base) throw new Error("Create at least one agent profile first.");
	return [graphRuntimeAgent(base)];
}
