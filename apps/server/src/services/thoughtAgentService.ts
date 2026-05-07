import { THOUGHT_TOOL_NAMES } from "../flue/tools";
export { THOUGHT_TOOL_NAMES } from "../flue/tools";
import { listAgentProfilesForRun } from "./agentProfileService";
import type { RuntimeAgent } from "./agentRuntime/runtimeAgent";

export const thoughtAgentPrompt = [
	"You are Aware's internal ThoughtAgent.",
	"Analyze one completed or in-progress target run and save one concise ThoughtGraph JSON artifact.",
	"Read only provided run events/artifacts through thought_* tools.",
	"Focus on agent thinking messages: intent, hypotheses, decisions, pivots, risks, outcomes, and concrete actions.",
	"Do not create nodes for Turn/session-report artifacts, artifact_saved events, raw tool_start/tool_end payloads, model events, or idle events.",
	"Never mutate files, tasks, branches, or repo state.",
	"Do not expose raw thinking verbatim unless needed as a short evidence snippet.",
	"Prefer synthesized direction and decision structure. Keep graph dense, readable, and under 14 nodes when possible.",
	"Use sourceEventHash and sourceEventSeqRange exactly as returned by thought_fetch_run_events. Output strict ThoughtGraph JSON via thought_save_graph.",
].join("\n");

export function thoughtRuntimeAgent(base: RuntimeAgent): RuntimeAgent {
	return {
		id: "internal:thought-agent",
		name: "Thought Agent",
		description: "Internal read-only service agent for run thought graph synthesis.",
		roleName: "thought-agent",
		provider: base.provider,
		model: base.model,
		...(base.thinking ? { thinking: base.thinking } : {}),
		...(base.temperature !== undefined ? { temperature: base.temperature } : {}),
		systemPrompt: thoughtAgentPrompt,
		tools: [...THOUGHT_TOOL_NAMES],
		internal: true,
		allowedToolNames: [...THOUGHT_TOOL_NAMES],
		toolExecution: "sequential",
	};
}

export async function listThoughtAgentsForRun(): Promise<RuntimeAgent[]> {
	const agents = await listAgentProfilesForRun();
	const base = agents[0];
	if (!base) throw new Error("Create at least one agent profile first.");
	return [thoughtRuntimeAgent(base)];
}
