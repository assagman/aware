import type { AgentProfile } from "@aware/shared";
import { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../app/api";

type ThinkingLevel =
	| "off"
	| "on"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";
type AgentForm = Pick<
	AgentProfile,
	"name" | "model" | "systemPrompt" | "thinking"
>;
type ProviderAuth = {
	provider: string;
	authenticated: boolean;
	source?: string;
	type?: "oauth" | "api_key";
	env?: string;
	path: string;
	login?: { running: boolean; url?: string; error?: string };
};

const openAIThinkingLevels: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];
const binaryThinkingLevels: ThinkingLevel[] = ["off", "on"];

function thinkingLevelsForProvider(provider: string) {
	return provider === "openai-codex"
		? openAIThinkingLevels
		: binaryThinkingLevels;
}

function defaultThinkingForProvider(provider: string) {
	return provider === "openai-codex" ? "medium" : "off";
}

const defaultForm: AgentForm = {
	name: "Code",
	model: "openai-codex/gpt-5.5",
	thinking: "medium",
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
		thinking: agent.thinking ?? "off",
		systemPrompt: agent.systemPrompt,
	};
}

export function AgentsPage() {
	const [items, setItems] = useState<AgentProfile[]>([]);
	const [form, setForm] = useState<AgentForm>(defaultForm);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [auth, setAuth] = useState<ProviderAuth | null>(null);
	const [apiKey, setApiKey] = useState("");
	const [authBusy, setAuthBusy] = useState(false);

	const selectedProvider = providerFromModel(form.model);
	const needsOAuth = selectedProvider === "openai-codex";
	const thinkingOptions = thinkingLevelsForProvider(selectedProvider);
	const selectedThinking = thinkingOptions.includes(
		(form.thinking ?? "off") as ThinkingLevel,
	)
		? ((form.thinking ?? "off") as ThinkingLevel)
		: defaultThinkingForProvider(selectedProvider);

	const load = () => {
		void apiGet<AgentProfile[]>("/agents").then(setItems);
	};
	const loadAuth = (provider = selectedProvider) => {
		void apiGet<ProviderAuth>(`/settings/providers/${provider}/auth`).then(
			setAuth,
		);
	};
	useEffect(() => {
		load();
	}, []);
	useEffect(() => {
		loadAuth(selectedProvider);
	}, [selectedProvider]);
	useEffect(() => {
		if (form.thinking !== selectedThinking) {
			setForm((current) => ({ ...current, thinking: selectedThinking }));
		}
	}, [form.thinking, selectedThinking]);

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
				thinking: selectedThinking,
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

	async function loginOpenAICodex() {
		setAuthBusy(true);
		setError(null);
		try {
			setAuth(await apiPost<ProviderAuth>("/settings/openai-codex/login", {}));
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "OpenAI Codex login failed",
			);
		} finally {
			setAuthBusy(false);
		}
	}

	async function saveApiKey() {
		setAuthBusy(true);
		setError(null);
		try {
			setAuth(
				await apiPost<ProviderAuth>(
					`/settings/providers/${selectedProvider}/api-key`,
					{ key: apiKey },
				),
			);
			setApiKey("");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save API key");
		} finally {
			setAuthBusy(false);
		}
	}

	return (
		<section id="agents" className="card">
			<h2>Agents</h2>
			<p>
				OpenAI Codex uses subscription OAuth login. Kimi and Z.AI use API keys.
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
			<select
				value={selectedThinking}
				onChange={(e) =>
					setForm({ ...form, thinking: e.target.value as ThinkingLevel })
				}
			>
				{thinkingOptions.map((level) => (
					<option key={level} value={level}>
						thinking: {level}
					</option>
				))}
			</select>
			<p>
				{selectedProvider} auth: {auth?.authenticated ? "connected" : "missing"}
				{auth?.source ? ` via ${auth.source}` : null}
				{auth?.env ? ` (${auth.env})` : null}
			</p>
			{!auth?.authenticated && needsOAuth ? (
				<button type="button" onClick={loginOpenAICodex} disabled={authBusy}>
					{authBusy ? "Waiting for OpenAI login..." : "Login with OpenAI"}
				</button>
			) : null}
			{!auth?.authenticated && !needsOAuth ? (
				<p>
					<input
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						placeholder={`${selectedProvider} API key`}
						type="password"
					/>
					<button type="button" onClick={saveApiKey} disabled={authBusy}>
						Save API key
					</button>
				</p>
			) : null}
			{auth?.login?.url && !auth.authenticated ? (
				<p>
					Login URL: <a href={auth.login.url}>{auth.login.url}</a>
				</p>
			) : null}
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
						{agent.name} — {agent.model} — thinking {agent.thinking ?? "off"}
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
