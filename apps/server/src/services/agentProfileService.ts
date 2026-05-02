import { randomUUID } from "node:crypto";
import type { AgentProfile } from "@agent-ide/shared";
import { db } from "../db/client";

const now = () => new Date().toISOString();

export const defaultAgentProfile = {
	name: "Code",
	provider: "openai-codex",
	model: "openai-codex/gpt-5.5",
	thinking: "medium",
	systemPrompt:
		"You are a careful coding agent. Inspect first, make minimal edits, explain changed files. Work only in selected worktree. Do not run git commit or git push without explicit approval.",
	tools: ["read", "write", "edit", "bash", "grep", "glob", "task"],
};

export async function listAgentProfiles() {
	const rows = await db.list<AgentProfile>("agentProfiles");
	if (rows.length) return rows;
	return [await createAgentProfile(defaultAgentProfile)];
}

function normalizeName(name: string) {
	return name.trim().toLowerCase();
}

async function assertUniqueAgentName(name: string, excludeId?: string) {
	const normalized = normalizeName(name);
	if (!normalized) throw new Error("Agent name is required");
	const duplicate = (await db.list<AgentProfile>("agentProfiles")).find(
		(agent) =>
			agent.id !== excludeId && normalizeName(agent.name) === normalized,
	);
	if (duplicate) throw new Error("Agent name already exists");
}

export async function createAgentProfile(
	input: Pick<AgentProfile, "name" | "provider" | "model" | "systemPrompt"> &
		Partial<AgentProfile>,
) {
	await assertUniqueAgentName(input.name);
	const row: AgentProfile = {
		id: randomUUID(),
		name: input.name.trim(),
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
	if (patch.name !== undefined) await assertUniqueAgentName(patch.name, id);
	return db.update<AgentProfile>("agentProfiles", id, {
		...patch,
		...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
		updatedAt: now(),
	});
}

export async function deleteAgentProfile(id: string) {
	await db.delete("agentProfiles", id);
}
