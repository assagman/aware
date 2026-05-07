import type { ThoughtGraph } from "@aware/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThoughtGraphPanel, thoughtGraphIsEmpty } from "./ThoughtGraphPanel";

const graph: ThoughtGraph = {
	version: 1,
	runId: "run-1",
	sourceEventSeqRange: [1, 2],
	sourceEventHash: "sha256:test",
	summary: "Decision followed evidence.",
	nodes: [
		{ id: "intent", kind: "intent", label: "User intent", detail: "Build graph", phase: "User intent", sourceEventIds: [] },
		{ id: "decision", kind: "decision", label: "Use cache", detail: "Cache artifact", phase: "Decisions", sourceEventIds: [] },
	],
	edges: [{ id: "e1", source: "intent", target: "decision", kind: "led_to" }],
	timeline: [],
	insights: [],
	risks: [],
	openQuestions: [],
	generatedAt: "2026-01-01T00:00:00.000Z",
};

describe("ThoughtGraphPanel", () => {
	it("renders graph lanes", () => {
		const html = renderToStaticMarkup(<ThoughtGraphPanel state={{ status: "ready", graph }} />);

		expect(html).toContain("Thought Graph");
		expect(html).toContain("Decision followed evidence");
		expect(html).toContain("User intent");
		expect(html).toContain("Use cache");
	});

	it("renders empty and error states", () => {
		const emptyGraph = { ...graph, nodes: [], edges: [] };
		expect(thoughtGraphIsEmpty(emptyGraph)).toBe(true);
		expect(renderToStaticMarkup(<ThoughtGraphPanel state={{ status: "ready", graph: emptyGraph }} />)).toContain("No thought graph nodes yet");
		expect(renderToStaticMarkup(<ThoughtGraphPanel state={{ status: "error", error: "boom" }} />)).toContain("Could not open thought graph");
	});
});
