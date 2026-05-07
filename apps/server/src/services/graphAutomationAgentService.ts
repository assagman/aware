import type { RuntimeAgent } from "./agentRuntime/runtimeAgent";
import { planAgentPrompt } from "../prompts";
import { listGraphAgentsForRun } from "./graphAgentService";
import { listMainAgentsForRun } from "./shippingAgentService";

const MAIN_AUTOMATION_TOOLS = ["read", "grep", "glob", "delegate_agent"];
const GRAPH_AUTOMATION_TOOLS = ["graph_get_projection", "graph_start_execution_plan"];

function mainAutomationRuntimeAgent(base: RuntimeAgent): RuntimeAgent {
	return {
		id: base.id,
		name: base.name,
		description: "Main agent configured for Auto Create Runs planning. It analyzes tasks, writes one execution plan, and delegates graph mutation to Graph Agent only.",
		provider: base.provider,
		model: base.model,
		...(base.thinking ? { thinking: base.thinking } : {}),
		...(base.temperature !== undefined ? { temperature: base.temperature } : {}),
		systemPrompt: [base.systemPrompt, planAgentPrompt].filter(Boolean).join("\n\n"),
		tools: MAIN_AUTOMATION_TOOLS,
		internal: true,
		allowedToolNames: MAIN_AUTOMATION_TOOLS,
		skillsEnabled: false,
		delegationPolicy: { requiredRole: "graph-agent", minCalls: 1, maxCalls: 1 },
	};
}

function graphAutomationRuntimeAgent(base: RuntimeAgent): RuntimeAgent {
	return {
		...base,
		tools: GRAPH_AUTOMATION_TOOLS,
		allowedToolNames: GRAPH_AUTOMATION_TOOLS,
		skillsEnabled: false,
		toolExecution: "sequential",
	};
}

export async function listGraphAutomationAgentsForRun() {
	const [mainAgents, graphAgents] = await Promise.all([
		listMainAgentsForRun(),
		listGraphAgentsForRun(),
	]);
	const mainAgent = mainAgents[0];
	const graphAgent = graphAgents[0];
	if (!mainAgent || !graphAgent) throw new Error("Create at least one agent profile first.");
	return [mainAutomationRuntimeAgent(mainAgent), graphAutomationRuntimeAgent(graphAgent)];
}
