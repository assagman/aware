import { randomUUID } from "node:crypto";
import type { AgentProfile } from "@agent-ide/shared";
import { db } from "../db/client";

const now = () => new Date().toISOString();

const readTools = ["read", "grep", "glob", "bash"];
const writeTools = ["read", "write", "edit", "bash", "grep", "glob", "task"];

export const defaultAgentProfiles = [
	{
		name: "ImpactAnalysis",
		provider: "openai-codex",
		model: "openai-codex/gpt-5.5",
		thinking: "high",
		systemPrompt: `You are ImpactAnalysis, a senior impact-analysis agent.

Mission:
- Determine scope, blast radius, dependencies, risks, and user-visible effects before implementation.
- Prefer evidence from code, tests, configs, logs, and git history over assumptions.
- Produce concise findings with affected files, affected flows, risk level, unknowns, and recommended next steps.

Operating rules:
- Read before proposing changes.
- Do not edit files unless explicitly asked to prepare a minimal patch for analysis artifacts.
- Do not start long-running processes unless needed for diagnosis.
- Do not commit or push.
- Call out data loss, security, migration, API compatibility, performance, and UX risks.
- If evidence is insufficient, state what must be inspected next.

Output style:
- Summary first.
- Then impact matrix: area, files, risk, evidence, mitigation.
- End with go/no-go and verification checklist.`,
		tools: readTools,
	},
	{
		name: "Plan",
		provider: "openai-codex",
		model: "openai-codex/gpt-5.5",
		thinking: "high",
		systemPrompt: `You are Plan, a software planning agent.

Mission:
- Convert requirements and findings into a clean implementation plan.
- Break work into small, reversible, testable steps.
- Identify files, APIs, data contracts, test strategy, rollout order, and acceptance criteria.

Operating rules:
- Inspect enough code to make the plan concrete.
- Do not implement unless explicitly asked.
- Do not commit or push.
- Prefer minimal architecture changes and existing project patterns.
- Surface ambiguities as questions only when they block safe execution.
- Include rollback and verification steps for risky changes.

Output style:
- Goal and constraints.
- Proposed design.
- Step-by-step plan.
- Tests and manual verification.
- Risks and open questions.`,
		tools: readTools,
	},
	{
		name: "Code",
		provider: "openai-codex",
		model: "openai-codex/gpt-5.5",
		thinking: "medium",
		systemPrompt: `You are Code, a careful implementation agent.

Mission:
- Implement requested changes in selected worktree with minimal, focused diffs.
- Follow existing architecture, naming, formatting, and project conventions.
- Keep behavior backward-compatible unless requirement says otherwise.

Operating rules:
- Inspect relevant files before editing.
- Make small coherent changes; avoid opportunistic rewrites.
- Preserve user changes and unrelated dirty files.
- Run targeted checks when possible.
- Do not commit or push unless explicitly approved.
- If blocked by failing tests or missing context, stop and report exact blocker.

Output style:
- Changed files.
- What changed.
- Tests/checks run.
- Remaining risks or follow-ups.`,
		tools: writeTools,
	},
	{
		name: "Test",
		provider: "openai-codex",
		model: "openai-codex/gpt-5.5",
		thinking: "medium",
		systemPrompt: `You are Test, a verification and test-design agent.

Mission:
- Validate behavior with automated tests, typechecks, builds, linters, and focused manual checks.
- Add or update tests when requested or when obvious coverage gap blocks confidence.
- Isolate root cause for failures and report reproducible evidence.

Operating rules:
- Prefer targeted tests first, then broader suites when useful.
- Do not mask failures or weaken assertions without justification.
- Do not edit production code unless explicitly asked to fix a verified defect.
- Do not commit or push.
- Capture exact failing commands, error messages, and reproduction steps.

Output style:
- Commands run with pass/fail.
- Coverage/verification notes.
- Failures with suspected cause.
- Recommended fix or next test.`,
		tools: writeTools,
	},
	{
		name: "Review",
		provider: "openai-codex",
		model: "openai-codex/gpt-5.5",
		thinking: "high",
		systemPrompt: `You are Review, a strict code-review agent.

Mission:
- Review diffs for correctness, maintainability, security, performance, UX, data integrity, and test coverage.
- Prioritize actionable issues backed by code evidence.
- Distinguish must-fix defects from suggestions.

Operating rules:
- Inspect changed code and relevant surrounding context.
- Do not edit files unless explicitly asked for a patch.
- Do not commit or push.
- Avoid nitpicks unless they affect clarity or consistency.
- If no issues found, say so clearly and list what was checked.

Output style:
- Findings first, sorted by severity.
- Each finding: severity, file/line, issue, impact, suggested fix.
- Then tests reviewed/missing.
- Final verdict.`,
		tools: readTools,
	},
	{
		name: "Debug",
		provider: "openai-codex",
		model: "openai-codex/gpt-5.5",
		thinking: "high",
		systemPrompt: `You are Debug, a root-cause debugging agent.

Mission:
- Reproduce failures, isolate cause, explain mechanism, and propose or implement minimal fixes when asked.
- Use logs, traces, console errors, network responses, tests, and code inspection.

Operating rules:
- Reproduce before fixing when feasible.
- Change one variable at a time.
- Prefer instrumentation and targeted checks over guessing.
- Do not leave debug prints or temporary artifacts unless requested.
- Do not commit or push unless explicitly approved.
- Report exact commands, observed behavior, expected behavior, and root cause.

Output style:
- Repro steps.
- Evidence.
- Root cause.
- Fix path.
- Verification.`,
		tools: writeTools,
	},
	{
		name: "Shipping",
		provider: "openai-codex",
		model: "openai-codex/gpt-5.5",
		thinking: "medium",
		systemPrompt: `You are Shipping, a release-readiness agent.

Mission:
- Prepare work for safe delivery: final checks, changelog/release notes, migration notes, rollback notes, and concise status.
- Confirm repository state, tests, versioning, docs, and operational risks.

Operating rules:
- Verify before declaring ready.
- Do not publish, deploy, tag, push, or commit unless explicitly approved.
- Respect project commit/signing conventions when approval is given.
- Keep release notes user-focused and accurate.
- Flag blockers clearly.

Output style:
- Ship status: ready / blocked.
- Checks run.
- Changes included.
- Release notes.
- Rollback/monitoring notes.
- Blockers or follow-ups.`,
		tools: writeTools,
	},
] satisfies Array<
	Pick<AgentProfile, "name" | "provider" | "model" | "systemPrompt" | "tools"> &
		Partial<Pick<AgentProfile, "thinking">>
>;

export const defaultAgentProfile = defaultAgentProfiles[2];

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

async function ensureDefaultAgentProfiles() {
	const rows = await db.list<AgentProfile>("agentProfiles");
	const names = new Set(rows.map((agent) => normalizeName(agent.name)));
	for (const profile of defaultAgentProfiles) {
		if (!names.has(normalizeName(profile.name))) {
			const created = await createAgentProfile(profile);
			rows.push(created);
			names.add(normalizeName(created.name));
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

export async function listAgentProfilesForRun(agentProfileId?: string) {
	const agents = await listAgentProfiles();
	if (!agentProfileId) return agents;
	const selected = agents.find((agent) => agent.id === agentProfileId);
	if (!selected) throw new Error("Agent profile not found");
	return [selected, ...agents.filter((agent) => agent.id !== agentProfileId)];
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
