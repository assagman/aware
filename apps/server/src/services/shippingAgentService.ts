import type { RuntimeAgent } from "./agentRuntime/runtimeAgent";
import { shippingAgentPrompt } from "../prompts";
import { listAgentProfilesForRun } from "./agentProfileService";
import { worktreeAgent } from "./worktreeAgentService";

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
	return serviceAgent(base, {
		id: "internal:shipping-agent",
		name: "Shipping Agent",
		roleName: "shipping-agent",
		description: "Internal service agent for commit, rebase, push, PR, merge, cleanup, and default-worktree sync.",
		systemPrompt: shippingAgent.prompt,
	});
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
		base,
		shippingRuntimeAgent(base),
		worktreeRuntimeAgent(base),
		...agents.filter((agent) => agent.id !== base.id),
	];
}

export async function listShippingAgentsForRun(): Promise<RuntimeAgent[]> {
	const agents = await listAgentProfilesForRun();
	const base = agents[0];
	if (!base) throw new Error("Create at least one agent profile first.");
	return [shippingRuntimeAgent(base)];
}
