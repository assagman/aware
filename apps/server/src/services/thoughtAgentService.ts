import { THOUGHT_TOOL_NAMES } from "../flue/tools";
export { THOUGHT_TOOL_NAMES } from "../flue/tools";
import { listAgentProfilesForRun } from "./agentProfileService";
import type { RuntimeAgent } from "./agentRuntime/runtimeAgent";

const THOUGHT_AGENT_PROVIDER = "openai-codex";
const THOUGHT_AGENT_MODEL = "openai-codex/gpt-5.5";
const THOUGHT_AGENT_THINKING = "xhigh";

export const thoughtAgentPrompt = [
	"You are Aware's internal ThoughtAgent.",
	"Analyze one completed or in-progress target run and save one concise ThoughtGraph JSON artifact.",
	"Use only thought_* tools. Never mutate files, tasks, branches, or repo state.",
	"You may inspect all provided inputs: messages, thinking deltas, tool calls/results, turn markers, artifacts, and session reports.",
	"The saved graph is user-visible. Distill final insights, decisions, pivots, risks, outcomes, and valuable concrete actions with clear connections.",
	"Do not surface raw tool dumps, Turn/session-report boilerplate, artifact bookkeeping, model/idle events, or low-value runtime metadata unless directly needed to explain an insight.",
	"Do not expose raw thinking verbatim except as a short evidence snippet. Prefer synthesized direction and decision structure.",
	"Keep graph dense, readable, and navigable: short labels, concise details, meaningful edges, useful timeline, and insight cards.",
	"Use sourceEventHash and sourceEventSeqRange exactly as returned by thought_fetch_run_events. Output strict ThoughtGraph JSON via thought_save_graph.",
].join("\n");

export function thoughtRuntimeAgent(_base: RuntimeAgent): RuntimeAgent {
	return {
		id: "internal:thought-agent",
		name: "Thought Agent",
		description: "Internal read-only service agent for LLM-only run thought graph synthesis.",
		roleName: "thought-agent",
		provider: THOUGHT_AGENT_PROVIDER,
		model: THOUGHT_AGENT_MODEL,
		thinking: THOUGHT_AGENT_THINKING,
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
