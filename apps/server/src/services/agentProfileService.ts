import { randomUUID } from "node:crypto";
import type { AgentProfile } from "@agent-ide/shared";
import { db } from "../db/client";

const now = () => new Date().toISOString();

export const defaultAgentProfile = {
	name: "Kimi Coder",
	provider: "kimi-coding",
	model: "kimi-coding/k2p6",
	systemPrompt:
		"You are a careful coding agent. Inspect first, make minimal edits, explain changed files. Do not run git commit or git push without explicit approval.",
	tools: ["read", "write", "edit", "bash", "grep", "glob", "task"],
};

export async function listAgentProfiles() {
	const rows = await db.list<AgentProfile>("agentProfiles");
	if (rows.length) return rows;
	return [await createAgentProfile(defaultAgentProfile)];
}

export async function createAgentProfile(
	input: Pick<AgentProfile, "name" | "provider" | "model" | "systemPrompt"> &
		Partial<AgentProfile>,
) {
	const row: AgentProfile = {
		id: randomUUID(),
		name: input.name,
		provider: input.provider,
		model: input.model,
		...(input.thinking ? { thinking: input.thinking } : {}),
		systemPrompt: input.systemPrompt,
		tools: input.tools ?? [],
		createdAt: now(),
		updatedAt: now(),
	};
	return db.insert("agentProfiles", row);
}

export async function updateAgentProfile(
	id: string,
	patch: Partial<AgentProfile>,
) {
	return db.update<AgentProfile>("agentProfiles", id, {
		...patch,
		updatedAt: now(),
	});
}
