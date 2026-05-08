import type { RuntimeAgent } from "./agentRuntime/runtimeAgent";
import { exploreAgentPrompt, reviewAgentPrompt, testAgentPrompt } from "../prompts";

function helperAgent(
	base: RuntimeAgent,
	input: {
		id: string;
		name: string;
		roleName: string;
		description: string;
		systemPrompt: string;
		allowedToolNames: string[];
		delegationPolicy?: RuntimeAgent["delegationPolicy"];
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
		tools: input.allowedToolNames,
		allowedToolNames: input.allowedToolNames,
		...(input.delegationPolicy ? { delegationPolicy: input.delegationPolicy } : {}),
		internal: true,
		skillsEnabled: false,
	};
}

export function exploreRuntimeAgent(base: RuntimeAgent): RuntimeAgent {
	return helperAgent(base, {
		id: "internal:explore-agent",
		name: "Explore Agent",
		roleName: "explore-agent",
		description: "Read-only context discovery agent for files, symbols, flows, and risks.",
		systemPrompt: exploreAgentPrompt,
		allowedToolNames: ["read", "grep", "glob"],
	});
}

export function reviewRuntimeAgent(base: RuntimeAgent): RuntimeAgent {
	return helperAgent(base, {
		id: "internal:review-agent",
		name: "Review Agent",
		roleName: "review-agent",
		description: "Adversarial read-only review agent for correctness, security, tests, and simplicity.",
		systemPrompt: reviewAgentPrompt,
		allowedToolNames: ["read", "grep", "glob", "delegate_agent"],
		delegationPolicy: { allowedRoles: ["explore-agent"] },
	});
}

export function testRuntimeAgent(base: RuntimeAgent): RuntimeAgent {
	return helperAgent(base, {
		id: "internal:test-agent",
		name: "Test Agent",
		roleName: "test-agent",
		description: "Targeted verification agent for tests, typechecks, builds, and failure summaries.",
		systemPrompt: testAgentPrompt,
		allowedToolNames: ["read", "grep", "glob", "bash", "delegate_agent"],
		delegationPolicy: { allowedRoles: ["explore-agent"] },
	});
}
