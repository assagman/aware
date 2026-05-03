import type { AgentRun } from "@agent-ide/shared";
import { useState } from "react";
import { apiPost } from "../app/api";
import { getSelection, setSelectedRunId } from "../app/selection";
import { AgentPicker } from "./AgentPicker";
import { RunLink } from "./RunLink";

export function DirectChat({ onSent }: { onSent?: () => void }) {
	const [message, setMessage] = useState("");
	const [status, setStatus] = useState("");
	const [runId, setRunId] = useState("");
	const [agentProfileId, setAgentProfileId] = useState("");
	async function send() {
		const { selectedProjectId, selectedWorktreeId } = getSelection();
		if (!selectedWorktreeId || !message.trim()) return;
		setStatus("starting agent run...");
		const run = await apiPost<AgentRun>("/chat", {
			projectId: selectedProjectId,
			worktreeId: selectedWorktreeId,
			agentProfileId,
			message,
		});
		setSelectedRunId(run.id);
		setRunId(run.id);
		setStatus(`run ${run.id} ${run.status}`);
		setMessage("");
		onSent?.();
	}
	return (
		<div className="direct-chat">
			<h3>Chat with agents</h3>
			<p>
				Sends current saved annotations for selected worktree. Sent annotations
				disappear from pending panel but stay in DB as sent.
			</p>
			<textarea
				value={message}
				onChange={(e) => setMessage(e.target.value)}
				onKeyDown={(e) => {
					if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
						e.preventDefault();
						void send();
					}
				}}
				placeholder="Tell agents what to do with saved annotations..."
			/>
			<div className="prompt-actions">
				<AgentPicker value={agentProfileId} onChange={setAgentProfileId} />
				<button type="button" onClick={send} disabled={!message.trim()}>
					Send
				</button>
			</div>
			{status ? (
				<p>
					{status}
					{runId ? (
						<>
							{" — "}
							<RunLink runId={runId}>open run</RunLink>
						</>
					) : null}
				</p>
			) : null}
		</div>
	);
}
