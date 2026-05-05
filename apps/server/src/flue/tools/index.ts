import type { ToolDef } from "@flue/sdk/client";
import { createExaTools, EXA_RETIRED_TOOL_NAMES, EXA_TOOL_NAMES } from "./exa";

const customToolNames = new Set<string>([...EXA_TOOL_NAMES]);

export function resolveAgentTools(toolNames: string[]): ToolDef[] {
	const requested = new Set(toolNames.filter((name) => customToolNames.has(name)));
	if (!requested.size) return [];
	return createExaTools().filter((tool) => requested.has(tool.name));
}

export { EXA_RETIRED_TOOL_NAMES, EXA_TOOL_NAMES };
