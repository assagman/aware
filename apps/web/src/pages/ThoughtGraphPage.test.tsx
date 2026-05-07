import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultThoughtGraphFilters } from "../components/ThoughtGraphView";
import { ThoughtGraphPageContent, type ThoughtGraphPageState } from "./ThoughtGraphPage";

const handlers = {
	onFiltersChange: vi.fn(),
	onSelectNode: vi.fn(),
	onRegenerate: vi.fn(),
	onExportJson: vi.fn(),
	onExportMarkdown: vi.fn(),
};

function render(state: ThoughtGraphPageState) {
	return renderToStaticMarkup(
		<ThoughtGraphPageContent
			state={state}
			filters={defaultThoughtGraphFilters}
			selectedNodeId=""
			{...handlers}
		/>,
	);
}

describe("ThoughtGraphPageContent", () => {
	it("renders loading state", () => {
		expect(render({ status: "loading" })).toContain("Analyzing thought direction");
	});

	it("renders error state", () => {
		expect(render({ status: "error", error: "boom" })).toContain("Could not open thought graph");
	});

	it("renders empty graph state", () => {
		const html = render({
			status: "ready",
			graph: {
				version: 1,
				runId: "run-1",
				sourceEventSeqRange: [0, 0],
				sourceEventHash: "sha256:test",
				summary: "No activity yet.",
				nodes: [],
				edges: [],
				timeline: [],
				insights: [],
				risks: [],
				openQuestions: [],
				generatedAt: "2026-01-01T00:00:00.000Z",
			},
		});

		expect(html).toContain("No thought graph nodes yet");
	});
});
