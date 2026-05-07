import { describe, expect, it } from "vitest";
import { thoughtGraphSchema } from "./thoughtGraph";

describe("thought graph schema", () => {
	it("accepts valid thought graph artifacts", () => {
		const parsed = thoughtGraphSchema.parse({
			version: 1,
			runId: "run-1",
			sourceEventSeqRange: [1, 3],
			sourceEventHash: "sha256:test",
			summary: "Decision followed evidence.",
			nodes: [{ id: "n1", kind: "decision", label: "Chose path", detail: "Use deterministic graph.", phase: "Decisions", sourceEventIds: [] }],
			edges: [],
			timeline: [],
			insights: [{ kind: "summary", text: "Useful handoff.", nodeIds: ["n1"] }],
			risks: [],
			openQuestions: [],
			generatedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(parsed.nodes[0]?.kind).toBe("decision");
	});

	it("rejects invalid node and edge kinds", () => {
		expect(() => thoughtGraphSchema.parse({
			version: 1,
			runId: "run-1",
			sourceEventSeqRange: [1, 1],
			sourceEventHash: "sha256:test",
			summary: "bad",
			nodes: [{ id: "n1", kind: "debug_dump", label: "Raw", detail: "No", phase: "Bad", sourceEventIds: [] }],
			edges: [{ id: "e1", source: "n1", target: "n2", kind: "owns" }],
			timeline: [],
			insights: [],
			risks: [],
			openQuestions: [],
			generatedAt: "2026-01-01T00:00:00.000Z",
		})).toThrow();
	});
});
