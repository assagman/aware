import type { ThoughtGraph } from "@aware/shared";
import { describe, expect, it } from "vitest";
import {
	defaultThoughtGraphFilters,
	layoutThoughtGraph,
	thoughtGraphIsEmpty,
	thoughtGraphMarkdownSummary,
} from "./ThoughtGraphView";

const graph: ThoughtGraph = {
	version: 1,
	runId: "run-1",
	sourceEventSeqRange: [1, 2],
	sourceEventHash: "sha256:test",
	summary: "Decision followed evidence.",
	nodes: [
		{ id: "intent", kind: "intent", label: "User intent", detail: "Build graph", phase: "User intent", sourceEventIds: [] },
		{ id: "evidence", kind: "evidence", label: "Read", detail: "Found API", phase: "Evidence/tool feedback", toolName: "read", confidence: 0.8, sourceEventIds: [] },
		{ id: "decision", kind: "decision", label: "Use cache", detail: "Cache artifact", phase: "Decisions", sourceEventIds: [] },
		{ id: "pivot", kind: "pivot", label: "Switch", detail: "Moved to page", phase: "Pivots", sourceEventIds: [] },
	],
	edges: [
		{ id: "e1", source: "intent", target: "evidence", kind: "led_to" },
		{ id: "e2", source: "evidence", target: "decision", kind: "supported_by" },
		{ id: "e3", source: "decision", target: "pivot", kind: "changed_mind" },
	],
	timeline: [],
	insights: [],
	risks: [],
	openQuestions: [],
	generatedAt: "2026-01-01T00:00:00.000Z",
};

describe("ThoughtGraphView helpers", () => {
	it("layouts graph nodes and edges independently", () => {
		const layout = layoutThoughtGraph(graph, defaultThoughtGraphFilters, "decision");

		expect(layout.nodes).toHaveLength(4);
		expect(layout.edges).toHaveLength(3);
		expect(layout.nodes.find((node) => node.id === "decision")?.data.selected).toBe(true);
	});

	it("filters pivots only", () => {
		const layout = layoutThoughtGraph(graph, { ...defaultThoughtGraphFilters, pivotsOnly: true });

		expect(layout.nodes.map((node) => node.id)).toEqual(["pivot"]);
		expect(layout.edges).toHaveLength(0);
	});

	it("reports empty and exports markdown", () => {
		const emptyGraph = { ...graph, nodes: [], edges: [] };
		expect(thoughtGraphIsEmpty(emptyGraph)).toBe(true);
		expect(thoughtGraphMarkdownSummary(graph)).toContain("## Decisions");
		expect(thoughtGraphMarkdownSummary(graph)).toContain("Use cache");
	});
});
