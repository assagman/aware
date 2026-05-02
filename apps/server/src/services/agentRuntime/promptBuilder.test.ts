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
});
