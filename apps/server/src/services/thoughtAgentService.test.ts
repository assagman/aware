import { describe, expect, it } from "vitest";
import { resolveAgentTools } from "../flue/tools";
import type { RuntimeAgent } from "./agentRuntime/runtimeAgent";
import { THOUGHT_TOOL_NAMES, thoughtRuntimeAgent } from "./thoughtAgentService";

describe("thought agent", () => {
	it("is internal, sequential, and read-only allow-listed", () => {
		const base: RuntimeAgent = {
			id: "base",
			name: "Base",
			provider: "provider",
			model: "model",
			systemPrompt: "base",
			tools: ["bash", "write", "edit"],
		};

		const agent = thoughtRuntimeAgent(base);

		expect(agent.roleName).toBe("thought-agent");
		expect(agent.internal).toBe(true);
		expect(agent.toolExecution).toBe("sequential");
		expect(agent.tools).toEqual([...THOUGHT_TOOL_NAMES]);
		expect(agent.allowedToolNames).toEqual([...THOUGHT_TOOL_NAMES]);
		expect(agent.tools).not.toContain("bash");
		expect(agent.tools).not.toContain("write");
		expect(agent.tools).not.toContain("edit");
	});

	it("registers only scoped thought tools when thought context is present", () => {
		const tools = resolveAgentTools([...THOUGHT_TOOL_NAMES], { thought: { runId: "run-1" } });

		expect(tools.map((tool) => tool.name).sort()).toEqual([...THOUGHT_TOOL_NAMES].sort());
		expect(resolveAgentTools([...THOUGHT_TOOL_NAMES]).map((tool) => tool.name)).toEqual([]);
	});
});
