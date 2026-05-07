import type { ThoughtGraph } from "@aware/shared";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	connectedThoughtGraphElementIds,
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
		{ id: "action", kind: "action", label: "Read file", detail: "Read src/a.ts", phase: "Evidence/tool feedback", toolName: "read", confidence: 0.8, sourceEventIds: [] },
		{ id: "decision", kind: "decision", label: "Use cache", detail: "Cache artifact", phase: "Decisions", sourceEventIds: [] },
		{ id: "pivot", kind: "pivot", label: "Switch", detail: "Moved to page", phase: "Pivots", sourceEventIds: [] },
	],
	edges: [
		{ id: "e1", source: "intent", target: "action", kind: "led_to" },
		{ id: "e2", source: "action", target: "decision", kind: "supported_by" },
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

	it("builds connected flow left-to-right with clear sibling spacing", () => {
		const branchingGraph: ThoughtGraph = {
			...graph,
			nodes: [
				{ id: "root", kind: "intent", label: "Root", detail: "Start", phase: "Exploration", sourceEventIds: [] },
				{ id: "branch-a", kind: "evidence", label: "Branch A", detail: "Evidence", phase: "Exploration", sourceEventIds: [] },
				{ id: "branch-b", kind: "evidence", label: "Branch B", detail: "Evidence", phase: "Exploration", sourceEventIds: [] },
				{ id: "final", kind: "decision", label: "Final", detail: "Decision", phase: "Exploration", sourceEventIds: [] },
			],
			edges: [
				{ id: "r-a", source: "root", target: "branch-a", kind: "led_to" },
				{ id: "r-b", source: "root", target: "branch-b", kind: "led_to" },
				{ id: "a-final", source: "branch-a", target: "final", kind: "supported_by" },
				{ id: "b-final", source: "branch-b", target: "final", kind: "supported_by" },
			],
		};
		const layout = layoutThoughtGraph(branchingGraph, defaultThoughtGraphFilters);
		const position = (id: string) => layout.nodes.find((node) => node.id === id)?.position;

		expect((position("branch-a")?.x ?? 0) - (position("root")?.x ?? 0)).toBeGreaterThanOrEqual(380);
		expect((position("final")?.x ?? 0) - (position("branch-a")?.x ?? 0)).toBeGreaterThanOrEqual(380);
		expect(Math.abs((position("branch-b")?.y ?? 0) - (position("branch-a")?.y ?? 0))).toBeGreaterThanOrEqual(220);
	});

	it("marks connected nodes and edges for hover focus", () => {
		const focus = connectedThoughtGraphElementIds(graph, "decision");
		const layout = layoutThoughtGraph(graph, defaultThoughtGraphFilters, "", "decision");

		expect(focus.nodeIds).toEqual(new Set(["action", "decision", "pivot"]));
		expect(focus.edgeIds).toEqual(new Set(["e2", "e3"]));
		expect(layout.nodes.find((node) => node.id === "decision")?.data.focusState).toBe("focused");
		expect(layout.nodes.find((node) => node.id === "action")?.data.focusState).toBe("connected");
		expect(layout.nodes.find((node) => node.id === "intent")?.data.focusState).toBe("dimmed");
		expect(layout.edges.find((edge) => edge.id === "e2")?.className).toContain("thought-edge-connected");
		expect(layout.edges.find((edge) => edge.id === "e1")?.className).toContain("thought-edge-dimmed");
	});

	it("does not animate edges only because they are hovered", () => {
		const layout = layoutThoughtGraph(graph, defaultThoughtGraphFilters, "", "e2");

		expect(layout.edges.find((edge) => edge.id === "e2")?.animated).toBe(false);
		expect(layout.edges.find((edge) => edge.id === "e3")?.animated).toBe(true);
	});

	it("keeps hover styles off ReactFlow interaction paths", () => {
		const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

		expect(styles).not.toMatch(/\.thought-edge[^,{]*\spath\b/);
		expect(styles).not.toMatch(/\.thought-edge[^,{]*\.react-flow__edge-interaction\b/);
	});

	it("reports empty and exports markdown", () => {
		const emptyGraph = { ...graph, nodes: [], edges: [] };
		expect(thoughtGraphIsEmpty(emptyGraph)).toBe(true);
		expect(thoughtGraphMarkdownSummary(graph)).toContain("## Decisions");
		expect(thoughtGraphMarkdownSummary(graph)).toContain("Use cache");
	});
});
