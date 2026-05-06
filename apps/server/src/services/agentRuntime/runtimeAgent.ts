import type { AgentProfile } from "@aware/shared";

export type RuntimeAgent = Pick<
	AgentProfile,
	"id" | "name" | "provider" | "model" | "systemPrompt" | "tools"
> &
	Partial<
		Pick<
			AgentProfile,
			"thinking" | "temperature" | "createdAt" | "updatedAt"
		>
	> & {
		description?: string;
		internal?: boolean;
		roleName?: string;
		allowedToolNames?: string[];
		toolExecution?: "parallel" | "sequential";
	};

function slug(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "agent";
}

export function runtimeAgentRoleName(agent: RuntimeAgent) {
	if (agent.roleName) return agent.roleName;
	return `agent-${slug(agent.name)}-${agent.id.slice(0, 8)}`;
}
