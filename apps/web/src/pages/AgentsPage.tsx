import type { AgentProfile } from "@agent-ide/shared";
import { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../app/api";

type AgentForm = Pick<AgentProfile, "name" | "model" | "systemPrompt">;

const defaultForm: AgentForm = {
	name: "OpenAI Codex GPT",
	model: "openai-codex/gpt-5.5",
	systemPrompt:
		"You are a coding agent. Inspect first, make minimal focused edits, do not commit/push without approval.",
};

function providerFromModel(model: string) {
	return model.split("/")[0] ?? "unknown";
}

function toForm(agent: AgentProfile): AgentForm {
	return {
		name: agent.name,
		model: agent.model,
		systemPrompt: agent.systemPrompt,
	};
}

export function AgentsPage() {
	const [items, setItems] = useState<AgentProfile[]>([]);
	const [form, setForm] = useState<AgentForm>(defaultForm);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const load = () => {
		void apiGet<AgentProfile[]>("/agents").then(setItems);
	};
	useEffect(load, []);

	const duplicate = items.find(
		(agent) =>
			agent.id !== editingId &&
			agent.name.trim().toLowerCase() === form.name.trim().toLowerCase(),
	);
	const canSave = form.name.trim().length > 0 && !duplicate && !saving;

	async function submit() {
		if (!canSave) return;
		setSaving(true);
		setError(null);
		try {
			const body = {
				...form,
				name: form.name.trim(),
				provider: providerFromModel(form.model),
			};
			if (editingId) await apiPatch(`/agents/${editingId}`, body);
			else await apiPost("/agents", body);
			setForm(defaultForm);
			setEditingId(null);
			load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save agent");
		} finally {
			setSaving(false);
		}
	}

	async function remove(id: string) {
		setError(null);
		await apiDelete(`/agents/${id}`);
		if (editingId === id) {
			setEditingId(null);
			setForm(defaultForm);
		}
		load();
	}

	function edit(agent: AgentProfile) {
		setEditingId(agent.id);
		setForm(toForm(agent));
		setError(null);
	}

	function cancelEdit() {
		setEditingId(null);
		setForm(defaultForm);
		setError(null);
	}

	return (
		<section id="agents" className="card">
			<h2>Agents</h2>
			<p>
				OpenAI Codex uses subscription OAuth login. Kimi uses KIMI_API_KEY.
				Fallback Z.AI uses Z_AI_API_KEY or ZAI_API_KEY.
			</p>
			<input
				value={form.name}
				onChange={(e) => setForm({ ...form, name: e.target.value })}
				placeholder="Agent name"
			/>
			<select
				value={form.model}
				onChange={(e) => setForm({ ...form, model: e.target.value })}
			>
				<option value="openai-codex/gpt-5.5">
					openai-codex/gpt-5.5 (OpenAI subscription OAuth)
				</option>
				<option value="kimi-coding/k2p6">kimi-coding/k2p6</option>
				<option value="kimi-coding/kimi-for-coding">
					kimi-coding/kimi-for-coding
				</option>
				<option value="zai/glm-5.1">zai/glm-5.1</option>
			</select>
			<textarea
				value={form.systemPrompt}
				onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
			/>
			{duplicate ? <p role="alert">Agent name already exists.</p> : null}
			{error ? <p role="alert">{error}</p> : null}
			<button type="button" onClick={submit} disabled={!canSave}>
				{editingId ? "Update agent" : "Save agent"}
			</button>
			{editingId ? (
				<button type="button" onClick={cancelEdit}>
					Cancel
				</button>
			) : null}
			<ul>
				{items.map((agent) => (
					<li key={agent.id}>
						{agent.name} — {agent.model}
						<button type="button" onClick={() => edit(agent)}>
							Edit
						</button>
						<button type="button" onClick={() => void remove(agent.id)}>
							Delete
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}
