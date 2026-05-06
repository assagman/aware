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
		expect(text).toContain("Selected agent:");
		expect(text).toContain("- Primary: provider openai-codex; model openai-codex/gpt-5.5; thinking medium; tools read, write");
		expect(text).toContain("Available agents (delegate with task tool; use exact role value):");
		expect(text).toContain("- Secondary: role agent-secondary-a2; agent profile");
		expect(text).not.toContain("Primary (selected)");
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
		expect(text).toContain("Upstream Artifactory:");
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
		expect(text).not.toContain("Task:");
		expect(text).not.toContain("User message:");
		expect(text).not.toContain("Selected annotations:");
		expect(text).toContain("- diff x.ts:1-2: revert");
		expect(text).toContain("Instructions:");
	});
});
