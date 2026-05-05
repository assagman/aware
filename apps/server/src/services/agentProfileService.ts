import { randomUUID } from "node:crypto";
import type { AgentProfile } from "@aware/shared";
import { db } from "../db/client";
import { EXA_RETIRED_TOOL_NAMES, EXA_TOOL_NAMES } from "../flue/tools";

const now = () => new Date().toISOString();

type DefaultAgentProfile = Pick<
	AgentProfile,
	"name" | "provider" | "model" | "systemPrompt" | "tools"
> &
	Partial<Pick<AgentProfile, "thinking">>;

const writeTools = ["read", "write", "edit", "bash", "grep", "glob", "task"];
const mainTools = [...writeTools, ...EXA_TOOL_NAMES];

const retiredDefaultAgentSignatures = [
	{ name: "ImpactAnalysis", promptPrefix: "You are ImpactAnalysis," },
	{ name: "Plan", promptPrefix: "You are Plan," },
	{ name: "Code", promptPrefix: "You are Code," },
	{ name: "Test", promptPrefix: "You are Test," },
	{ name: "Review", promptPrefix: "You are Review," },
	{ name: "Debug", promptPrefix: "You are Debug," },
	{ name: "Shipping", promptPrefix: "You are Shipping," },
];

export const defaultAgentProfiles: DefaultAgentProfile[] = [
	{
		name: "Main",
		provider: "openai-codex",
		model: "openai-codex/gpt-5.5",
		thinking: "medium",
		systemPrompt: `You are Main, the default aware coding agent.

Mission:
- Handle all aware runs with careful, minimal, focused changes.
- Inspect relevant files before editing.
- Follow existing project conventions and preserve unrelated user changes.
- Run targeted checks when practical.

Operating rules:
- Work only in the assigned worktree.
- Do not commit or push unless explicitly approved.
- If blocked, report the exact blocker and safest next step.

Output style:
- Changed files.
- What changed.
- Tests/checks run.
- Remaining risks or follow-ups.`,
		tools: mainTools,
	},
];

export const defaultAgentProfile = defaultAgentProfiles[0];

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
		...(input.temperature !== undefined
			? { temperature: input.temperature }
			: {}),
		systemPrompt: input.systemPrompt,
		tools: input.tools ?? [],
		createdAt: now(),
		updatedAt: now(),
	};
	return db.insert("agentProfiles", row);
}

function isRetiredDefaultAgent(agent: AgentProfile) {
	const signature = retiredDefaultAgentSignatures.find(
		(item) => normalizeName(item.name) === normalizeName(agent.name),
	);
	return Boolean(
		signature &&
			agent.provider === "openai-codex" &&
			agent.model === "openai-codex/gpt-5.5" &&
			agent.systemPrompt.trim().startsWith(signature.promptPrefix),
	);
}

async function removeRetiredDefaultAgentProfiles(rows: AgentProfile[]) {
	const kept: AgentProfile[] = [];
	for (const row of rows) {
		if (isRetiredDefaultAgent(row)) await db.delete("agentProfiles", row.id);
		else kept.push(row);
	}
	return kept;
}

async function ensureDefaultAgentProfiles() {
	const rows = await removeRetiredDefaultAgentProfiles(
		await db.list<AgentProfile>("agentProfiles"),
	);
	for (const profile of defaultAgentProfiles) {
		const existing = rows.find(
			(agent) => normalizeName(agent.name) === normalizeName(profile.name),
		);
		if (!existing) {
			const created = await createAgentProfile(profile);
			rows.push(created);
			continue;
		}
		const activeTools = existing.tools.filter(
			(tool) => !EXA_RETIRED_TOOL_NAMES.includes(tool),
		);
		const missingTools = profile.tools.filter(
			(tool) => !activeTools.includes(tool),
		);
		const nextTools = [...activeTools, ...missingTools];
		if (nextTools.length !== existing.tools.length || missingTools.length) {
			const updated = await db.update<AgentProfile>("agentProfiles", existing.id, {
				tools: nextTools,
				updatedAt: now(),
			});
			if (updated) rows[rows.indexOf(existing)] = updated;
		}
	}
	const defaultOrder = new Map(
		defaultAgentProfiles.map((profile, index) => [
			normalizeName(profile.name),
			index,
		]),
	);
	return rows.sort((left, right) => {
		const leftOrder =
			defaultOrder.get(normalizeName(left.name)) ?? Number.MAX_SAFE_INTEGER;
		const rightOrder =
			defaultOrder.get(normalizeName(right.name)) ?? Number.MAX_SAFE_INTEGER;
		return leftOrder - rightOrder || left.name.localeCompare(right.name);
	});
}

export async function listAgentProfiles() {
	return ensureDefaultAgentProfiles();
}

export async function listAgentProfilesForRun() {
	const agents = await listAgentProfiles();
	const main = agents.find((agent) => normalizeName(agent.name) === "main");
	return [
		...(main ? [main] : []),
		...agents.filter((agent) => agent.id !== main?.id),
	];
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
