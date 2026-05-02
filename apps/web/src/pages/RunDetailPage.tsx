import type { AgentRun, RunEvent } from "@agent-ide/shared";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../app/api";
import { getSelection, setSelectedRunId } from "../app/selection";

type Payload = Record<string, unknown>;

function textOf(payload: unknown) {
	const p = payload as Payload;
	if (typeof p.text === "string") return p.text;
	if (typeof p.delta === "string") return p.delta;
	if (typeof p.message === "string") return p.message;
	if (
		p.data &&
		typeof p.data === "object" &&
		"text" in p.data &&
		typeof (p.data as Payload).text === "string"
	)
		return (p.data as Payload).text as string;
	return "";
}

function AssistantMarkdown({ text }: { text: string }) {
	return <div className="markdown-text">{text}</div>;
}

function ToolEvent({ event }: { event: RunEvent }) {
	const p = event.payload as Payload;
	const name = String(p.toolName ?? event.type);
	const args = p.args ? JSON.stringify(p.args, null, 2) : "";
	const result = p.result ? JSON.stringify(p.result, null, 2) : "";
	return (
		<details className="tool-event">
			<summary>
				{event.type === "tool_start" ? "Tool start" : "Tool end"}: {name}
			</summary>
			{args ? <pre>{args}</pre> : null}
			{result ? <pre>{result}</pre> : null}
		</details>
	);
}

function RunTranscript({ events }: { events: RunEvent[] }) {
	const assistantText = events
		.filter((e) => e.type === "text_delta")
		.map((e) => textOf(e.payload))
		.join("");
	const prompt = events.find((e) => e.type === "prompt");
	const errors = events.filter((e) => e.type === "error");
	const result = events.find((e) => e.type === "result");
	const tools = events.filter(
		(e) => e.type === "tool_start" || e.type === "tool_end",
	);
	const model = events.find((e) => e.type === "model");
	return (
		<div className="run-transcript">
			{model ? (
				<details>
					<summary>Model</summary>
					<pre>{JSON.stringify(model.payload, null, 2)}</pre>
				</details>
			) : null}
			{prompt ? (
				<details>
					<summary>System prompt + user message</summary>
					<pre>{textOf(prompt.payload)}</pre>
				</details>
			) : null}
			{assistantText ? (
				<section className="assistant-message">
					<h3>Assistant</h3>
					<AssistantMarkdown text={assistantText} />
				</section>
			) : null}
			{tools.length ? (
				<section>
					<h3>Tool calls</h3>
					{tools.map((e) => (
						<ToolEvent key={e.id} event={e} />
					))}
				</section>
			) : null}
			{result ? (
				<details open>
					<summary>Final result</summary>
					<pre>{JSON.stringify(result.payload, null, 2)}</pre>
				</details>
			) : null}
			{errors.map((e) => (
				<details key={e.id} open className="error">
					<summary>Error</summary>
					<pre>{JSON.stringify(e.payload, null, 2)}</pre>
				</details>
			))}
		</div>
	);
}

export function RunDetailPage() {
	const [runs, setRuns] = useState<AgentRun[]>([]);
	const [runId, setRunId] = useState(getSelection().selectedRunId);
	const [events, setEvents] = useState<RunEvent[]>([]);
	const selectedRun = useMemo(
		() => runs.find((r) => r.id === runId),
		[runs, runId],
	);
	async function loadRuns() {
		const rows = await apiGet<AgentRun[]>("/runs");
		setRuns(rows);
		if (!runId && rows[0]) setRunId(rows[0].id);
	}
	async function loadEvents(id = runId) {
		if (!id) return;
		setEvents(await apiGet<RunEvent[]>(`/runs/${id}/events`));
		setSelectedRunId(id);
	}
	useEffect(() => {
		void loadRuns();
	}, []);
	useEffect(() => {
		if (runId) void loadEvents(runId);
	}, [runId]);
	return (
		<section id="runs" className="card">
			<div className="panel-head">
				<h2>Runs</h2>
				<button
					type="button"
					onClick={() => {
						void loadRuns();
						void loadEvents();
					}}
				>
					Refresh
				</button>
			</div>
			<label>
				Run{" "}
				<select value={runId} onChange={(e) => setRunId(e.target.value)}>
					<option value="">select run</option>
					{runs.map((r) => (
						<option key={r.id} value={r.id}>
							{r.status} — {new Date(r.startedAt).toLocaleString()} —{" "}
							{r.id.slice(0, 8)}
						</option>
					))}
				</select>
			</label>
			{selectedRun ? (
				<p>
					Status: <strong>{selectedRun.status}</strong> Started:{" "}
					{new Date(selectedRun.startedAt).toLocaleString()} Run:{" "}
					<code>{selectedRun.id}</code>
				</p>
			) : null}
			<RunTranscript events={events} />
		</section>
	);
}
