import type { AgentProfile } from "@agent-ide/shared";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../app/api";

export function AgentsPage() {
	const [items, setItems] = useState<AgentProfile[]>([]);
	const [name, setName] = useState("Kimi Coder");
	const [model, setModel] = useState("kimi-coding/k2p6");
	const [systemPrompt, setSystemPrompt] = useState(
		"You are a coding agent. Inspect first, make minimal focused edits, do not commit/push without approval.",
	);
	const load = () => {
		void apiGet<AgentProfile[]>("/agents").then(setItems);
	};
	useEffect(load, []);
	async function submit() {
		await apiPost("/agents", {
			name,
			provider: model.split("/")[0] ?? "unknown",
			model,
			systemPrompt,
		});
		load();
	}
	return (
		<section id="agents" className="card">
			<h2>Agents</h2>
			<p>
				Kimi uses KIMI_API_KEY. Fallback Z.AI uses Z_AI_API_KEY or ZAI_API_KEY.
			</p>
			<input value={name} onChange={(e) => setName(e.target.value)} />
			<select value={model} onChange={(e) => setModel(e.target.value)}>
				<option value="kimi-coding/k2p6">kimi-coding/k2p6</option>
				<option value="kimi-coding/kimi-for-coding">
					kimi-coding/kimi-for-coding
				</option>
				<option value="zai/glm-5.1">zai/glm-5.1</option>
			</select>
			<textarea
				value={systemPrompt}
				onChange={(e) => setSystemPrompt(e.target.value)}
			/>
			<button type="button" onClick={submit}>
				Save agent
			</button>
			<ul>
				{items.map((a) => (
					<li key={a.id}>
						{a.name} — {a.model}
					</li>
				))}
			</ul>
		</section>
	);
}
