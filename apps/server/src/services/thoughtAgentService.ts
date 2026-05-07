import type { RuntimeAgent } from "./agentRuntime/runtimeAgent";

export const THOUGHT_TOOL_NAMES = [
	"thought_fetch_run_events",
	"thought_fetch_artifacts",
	"thought_save_graph",
] as const;

export type ThoughtToolName = (typeof THOUGHT_TOOL_NAMES)[number];

export const thoughtAgentPrompt = [
	"You are Aware's internal ThoughtAgent.",
	"Analyze one completed or in-progress run. Build concise thought graph JSON showing reasoning direction, decisions, pivots, evidence, risks, and unresolved questions.",
	"Read only provided run events/artifacts.",
	"Never mutate files, tasks, branches, or repo state.",
	"Do not expose raw thinking verbatim unless needed as short evidence snippet.",
	"Prefer synthesized direction and decision structure. Preserve chronology. Output strict ThoughtGraph JSON.",
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
