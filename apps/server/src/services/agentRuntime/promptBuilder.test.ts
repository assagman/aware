import { describe, expect, it } from "vitest";
import { buildPrompt } from "./promptBuilder";

describe("prompt builder", () => {
	it("includes task and annotations", () => {
		const text = buildPrompt({
			task: {
				id: "t",
				projectId: "p",
				worktreeId: "w",
				title: "Fix bug",
				body: "Do it",
				status: "draft",
				createdAt: "",
				updatedAt: "",
			},
			agents: [],
			annotations: [
				{
					id: "a",
					projectId: "p",
					worktreeId: "w",
					kind: "file",
					filePath: "x.ts",
					text: "note",
					sent: false,
					createdAt: "",
					updatedAt: "",
				},
			],
		});
		expect(text).toContain("Fix bug");
		expect(text).toContain("note");
	});

	it("lists all available agents", () => {
		const text = buildPrompt({
			task: {
				id: "t",
				projectId: "p",
				worktreeId: "w",
				title: "List agents",
				body: "List all agents in the system",
				status: "draft",
				createdAt: "",
				updatedAt: "",
			},
			agents: [
				{
					id: "a1",
					name: "Primary",
					provider: "openai-codex",
					model: "openai-codex/gpt-5.5",
					thinking: "medium",
					systemPrompt: "primary",
					tools: ["read", "write"],
					createdAt: "",
					updatedAt: "",
				},
				{
					id: "a2",
					name: "Secondary",
					provider: "openai-codex",
					model: "openai-codex/gpt-5.5",
					systemPrompt: "secondary",
					tools: [],
					createdAt: "",
					updatedAt: "",
				},
			],
			annotations: [],
		});
		expect(text).toContain("# User message");
		expect(text).toContain("### Selected agent");
		expect(text).toContain("- Primary: provider openai-codex; model openai-codex/gpt-5.5; thinking medium; tools read, write; skills per profile policy");
		expect(text).toContain("### Available agents");
		expect(text).toContain("Delegate with the `task` tool using the exact role value.");
		expect(text).toContain("- Secondary: role agent-secondary-a2; agent profile");
		expect(text).not.toContain("Primary (selected)");
	});

	it("uses delegate_agent instructions for scoped delegation agents", () => {
		const text = buildPrompt({
			task: {
				id: "t",
				projectId: "p",
				worktreeId: "w",
				title: "Plan graph",
				body: "Plan only",
				status: "draft",
				createdAt: "",
				updatedAt: "",
			},
			agents: [
				{
					id: "planner",
					name: "Plan Agent",
					provider: "openai-codex",
					model: "openai-codex/gpt-5.5",
					systemPrompt: "planner",
					tools: ["read", "delegate_agent"],
					allowedToolNames: ["read", "delegate_agent"],
					skillsEnabled: false,
				},
				{
					id: "graph",
					name: "Graph Agent",
					provider: "openai-codex",
					model: "openai-codex/gpt-5.5",
					systemPrompt: "graph",
					tools: ["graph_start_run"],
					roleName: "graph-agent",
					skillsEnabled: false,
				},
			],
			annotations: [],
		});

		expect(text).toContain("Delegate with the `delegate_agent` tool using the exact role value.");
		expect(text).not.toContain("Delegate with the `task` tool using the exact role value.");
	});

	it("includes upstream artifactory context", () => {
		const text = buildPrompt({
			task: {
				id: "t",
				projectId: "p",
				worktreeId: "w",
				title: "Use artifacts",
				body: "Continue",
				status: "draft",
				createdAt: "",
				updatedAt: "",
			},
			agents: [],
			annotations: [],
			upstreamArtifacts: "prior report",
		});
		expect(text).toContain("### Upstream Artifactory");
		expect(text).toContain("prior report");
	});

	it("keeps annotation-sent prompts concise", () => {
		const text = buildPrompt({
			task: {
				id: "t",
				projectId: "p",
				worktreeId: "w",
				title: "annotation-sent",
				body: "revert",
				status: "draft",
				createdAt: "",
				updatedAt: "",
			},
			agents: [],
			annotations: [
				{
					id: "a",
					projectId: "p",
					worktreeId: "w",
					kind: "diff",
					filePath: "x.ts",
					startLine: 1,
					endLine: 2,
					text: "revert",
					sent: false,
					createdAt: "",
					updatedAt: "",
				},
			],
			message: "revert",
		});
		expect(text).toContain("# User message");
		expect(text).toContain("## Annotation request");
		expect(text).toContain("## Selected annotations");
		expect(text).toContain("- diff x.ts:1-2: revert");
		expect(text).not.toContain("Work only in assigned worktree");
		expect(text).not.toContain("artifactory_save_session_report");
	});
});
