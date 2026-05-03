import { describe, expect, it } from "vitest";
import { isWorkspacePath, worktreePathForBranch } from "./workspaceConvention";
import { classifyTaskChange, slugifyTask } from "./worktreeNaming";

describe("Worktree agent", () => {
	it("classifies dedicated change categories", () => {
		expect(classifyTaskChange({ title: "Fix auth crash", body: "" })).toBe(
			"fix",
		);
		expect(classifyTaskChange({ title: "Add API route", body: "" })).toBe(
			"api",
		);
		expect(
			classifyTaskChange({ title: "Improve screen reader labels", body: "" }),
		).toBe("ux");
		expect(
			classifyTaskChange({ title: "Document install flow", body: "" }),
		).toBe("docs");
		expect(classifyTaskChange({ title: "Add dashboard", body: "" })).toBe(
			"feat",
		);
	});

	it("preserves explicit categories without duplicating slug prefix", () => {
		const task = { title: "experiment: try new agent UI", body: "" };
		expect(classifyTaskChange(task)).toBe("experiment");
		expect(slugifyTask(task)).toBe("try-new-agent-ui");
	});

	it("creates minimal max-four-word slug", () => {
		expect(
			slugifyTask({
				title: "Fix worktree behavior when starting a new task",
				body: "",
			}),
		).toBe("behavior-when-starting-new");
	});

	it("maps branch into workspace convention", () => {
		expect(worktreePathForBranch("fix/worktree-behavior")).toBe(
			"/workspace/fix/worktree-behavior",
		);
		expect(isWorkspacePath("/workspace/main")).toBe(true);
		expect(isWorkspacePath("/tmp/main")).toBe(false);
	});
});
