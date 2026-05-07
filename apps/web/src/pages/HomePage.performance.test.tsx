import type { RunEvent } from "@aware/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatTimeline, MarkdownText } from "./HomePage";

function expectMemoComponent(component: unknown) {
	expect(String((component as { $$typeof?: symbol }).$$typeof)).toBe(
		"Symbol(react.memo)",
	);
}

const events: RunEvent[] = [
	{
		id: "run-1:1",
		runId: "run-1",
		seq: 1,
		type: "user_message",
		payload: { text: "Keep the input responsive." },
		createdAt: "2026-01-01T00:00:00.000Z",
	},
	{
		id: "run-1:2",
		runId: "run-1",
		seq: 2,
		type: "text_delta",
		payload: { text: "Large markdown history should not re-render per draft key." },
		createdAt: "2026-01-01T00:00:01.000Z",
	},
];

describe("run chat rendering performance", () => {
	it("memoizes markdown blocks and chat history for prompt draft edits", () => {
		expectMemoComponent(MarkdownText);
		expectMemoComponent(ChatTimeline);

		const html = renderToStaticMarkup(<ChatTimeline events={events} />);

		expect(html).toContain("Keep the input responsive.");
		expect(html).toContain("Large markdown history should not re-render per draft key.");
	});
});
