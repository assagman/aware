import type { RuntimeAgent } from "./agentRuntime/runtimeAgent";
import { shippingAgentPrompt } from "../prompts";
import { listAgentProfilesForRun } from "./agentProfileService";
import { worktreeAgent } from "./worktreeAgentService";
import { exploreRuntimeAgent, reviewRuntimeAgent, testRuntimeAgent } from "./helperAgentService";

export const shippingAgent = {
	name: "Shipping",
	prompt: shippingAgentPrompt,
};

function serviceAgent(
	base: RuntimeAgent,
	input: {
		id: string;
		name: string;
		systemPrompt: string;
		roleName: string;
		description: string;
	},
): RuntimeAgent {
	return {
		id: input.id,
		name: input.name,
		description: input.description,
		roleName: input.roleName,
		provider: base.provider,
		model: base.model,
		...(base.thinking ? { thinking: base.thinking } : {}),
		...(base.temperature !== undefined ? { temperature: base.temperature } : {}),
		systemPrompt: input.systemPrompt,
		tools: base.tools,
		internal: true,
	};
}

function shippingRuntimeAgent(base: RuntimeAgent) {
	return {
		...serviceAgent(base, {
		id: "internal:shipping-agent",
		name: "Shipping Agent",
		roleName: "shipping-agent",
		description: "Internal service agent for commit, rebase, push, PR creation, and PR merge.",
		systemPrompt: shippingAgent.prompt,
		}),
		tools: base.tools.filter((tool) => tool !== "delegate_agent"),
		allowedToolNames: base.tools.filter((tool) => tool !== "delegate_agent"),
		delegationPolicy: { maxCalls: 0 },
	};
}

function worktreeRuntimeAgent(base: RuntimeAgent) {
	return serviceAgent(base, {
		id: "internal:worktree-agent",
		name: "Worktree Agent",
		roleName: "worktree-agent",
		description: "Internal service agent for resolving task worktrees before coding runs.",
		systemPrompt: worktreeAgent.prompt,
	});
}

export async function listMainAgentsForRun(): Promise<RuntimeAgent[]> {
	const agents = await listAgentProfilesForRun();
	const base = agents[0];
	if (!base) throw new Error("Create at least one agent profile first.");
	return [
		{ ...base, delegationPolicy: { maxCalls: 20 } },
		shippingRuntimeAgent(base),
		exploreRuntimeAgent(base),
		reviewRuntimeAgent(base),
		testRuntimeAgent(base),
		...agents.filter((agent) => agent.id !== base.id).map((agent) => ({
			...agent,
			tools: agent.tools.includes("delegate_agent") ? agent.tools : [...agent.tools, "delegate_agent"],
			delegationPolicy: { allowedRoles: ["explore-agent"] },
		})),
	];
}

export async function listShippingAgentsForRun(): Promise<RuntimeAgent[]> {
	const agents = await listAgentProfilesForRun();
	const base = agents[0];
	if (!base) throw new Error("Create at least one agent profile first.");
	return [shippingRuntimeAgent(base)];
}
