import { Type, type ToolDef } from "@flue/sdk/client";
import { loadAgentSkill } from "../../services/skillCatalogService";
import type { RuntimeAgent } from "../../services/agentRuntime/runtimeAgent";

const skillToolNames = ["load_skill"] as const;

export type SkillToolName = (typeof skillToolNames)[number];
export const SKILL_TOOL_NAMES: readonly SkillToolName[] = skillToolNames;

export type SkillToolContext = {
	projectId?: string;
	agent?: RuntimeAgent;
};

function stringifyResult(result: unknown) {
	return JSON.stringify(result, null, 2);
}

export function createSkillTools(context: SkillToolContext): ToolDef[] {
	return [
		{
			name: "load_skill",
			description: [
				"Load full SKILL.md instructions for a discovered Aware/Flue skill by name or id.",
				"Use before following a matching Available Skills catalog entry.",
				"Skill policy is enforced; disabled skills cannot be loaded.",
			].join(" "),
			parameters: Type.Object({
				skill: Type.String({
					description: "Skill name, directory, id, or relative SKILL.md path.",
				}),
			}),
			execute: async (args) =>
				stringifyResult(
					await loadAgentSkill({
						...(context.projectId ? { projectId: context.projectId } : {}),
						...(context.agent ? { agent: context.agent } : {}),
						skill: args.skill,
					}),
				),
		},
	];
}
