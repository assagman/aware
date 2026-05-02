import type { AgentRun } from "@agent-ide/shared";
import { useState } from "react";
import { apiPost } from "../app/api";
import { getSelection, setSelectedRunId } from "../app/selection";

export function DirectChat({ onSent }: { onSent?: () => void }) {
	const [message, setMessage] = useState("");
	const [status, setStatus] = useState("");
	async function send() {
		const { selectedProjectId, selectedWorktreeId } = getSelection();
		if (!selectedWorktreeId || !message.trim()) return;
		setStatus("starting agent run...");
		const run = await apiPost<AgentRun>("/chat", {
			projectId: selectedProjectId,
			worktreeId: selectedWorktreeId,
			message,
		});
		setSelectedRunId(run.id);
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
				placeholder="Tell agents what to do with saved annotations..."
			/>
			<button type="button" onClick={send} disabled={!message.trim()}>
				Send to agents
			</button>
			{status ? (
				<p>
					{status} — <a href="#runs">open run</a>
				</p>
			) : null}
		</div>
	);
}
