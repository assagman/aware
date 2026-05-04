import type { AgentProfile } from "@aware/shared";
import {
	codeBlockPlugin,
	headingsPlugin,
	linkPlugin,
	listsPlugin,
	markdownShortcutPlugin,
	MDXEditor,
	tablePlugin,
	thematicBreakPlugin,
	quotePlugin,
	type MDXEditorMethods,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../app/api";
import { getPageState, setPageState } from "../app/pageState";

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
	"name" | "model" | "systemPrompt" | "thinking" | "temperature"
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
type GlobalInstructions = { text: string; path: string };
type AgentsView = "agents" | "global" | "auth";

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
	name: "",
	model: "openai-codex/gpt-5.5",
	thinking: "medium",
	temperature: 0.2,
	systemPrompt:
		"Inspect first, make minimal focused edits, do not commit/push without approval.",
};

function MarkdownEditor({
	text,
	onChange,
	placeholder,
	ariaLabel,
}: {
	text: string;
	onChange: (text: string) => void;
	placeholder: string;
	ariaLabel: string;
}) {
	const editorRef = useRef<MDXEditorMethods>(null);
	const plugins = useMemo(
		() => [
			headingsPlugin(),
			listsPlugin(),
			linkPlugin(),
			quotePlugin(),
			thematicBreakPlugin(),
			tablePlugin(),
			codeBlockPlugin(),
			markdownShortcutPlugin(),
		],
		[],
	);

	useEffect(() => {
		const editor = editorRef.current;
		if (editor && editor.getMarkdown() !== text) {
			editor.setMarkdown(text);
		}
	}, [text]);

	return (
		<div className="markdown-editor" aria-label={ariaLabel}>
			<MDXEditor
				ref={editorRef}
				markdown={text}
				onChange={(value) => onChange(value)}
				placeholder={placeholder}
				plugins={plugins}
				className="agent-mdx-editor dark-theme"
				contentEditableClassName="markdown-text agent-mdx-content"
				suppressHtmlProcessing
				trim={false}
			/>
		</div>
	);
}

function providerFromModel(model: string) {
	return model.split("/")[0] ?? "unknown";
}

function toForm(agent: AgentProfile): AgentForm {
	return {
		name: agent.name,
		model: agent.model,
		thinking: agent.thinking ?? "off",
		temperature: agent.temperature ?? 0.2,
		systemPrompt: agent.systemPrompt,
	};
}

const initialAgentsState = getPageState("agents", {
	activeView: "agents" as AgentsView,
	editingId: null as string | null,
	form: defaultForm,
	apiKey: "",
	globalInstructions: "",
});

export function AgentsPage() {
	const [items, setItems] = useState<AgentProfile[]>([]);
	const [form, setForm] = useState<AgentForm>(initialAgentsState.form);
	const [editingId, setEditingId] = useState<string | null>(initialAgentsState.editingId);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [auth, setAuth] = useState<ProviderAuth | null>(null);
	const [apiKey, setApiKey] = useState(initialAgentsState.apiKey);
	const [authBusy, setAuthBusy] = useState(false);
	const [globalInstructions, setGlobalInstructions] = useState(initialAgentsState.globalInstructions);
	const [globalPath, setGlobalPath] = useState("~/.agents/AGENTS.md");
	const [globalSaving, setGlobalSaving] = useState(false);
	const [activeView, setActiveView] = useState<AgentsView>(initialAgentsState.activeView);

	const selectedProvider = providerFromModel(form.model);
	const needsOAuth = selectedProvider === "openai-codex";
	const thinkingOptions = thinkingLevelsForProvider(selectedProvider);
	const selectedThinking = thinkingOptions.includes(
		(form.thinking ?? "off") as ThinkingLevel,
	)
		? ((form.thinking ?? "off") as ThinkingLevel)
		: defaultThinkingForProvider(selectedProvider);
	const selectedAgent = items.find((agent) => agent.id === editingId);
	const authStatus = auth?.authenticated ? "connected" : "missing";

	const load = (selectFirst = false) => {
		void apiGet<AgentProfile[]>("/agents").then((agents) => {
			setItems(agents);
			if (editingId && !agents.some((agent) => agent.id === editingId)) {
				setEditingId(null);
				setPageState("agents", { editingId: null });
			}
			if (selectFirst && !editingId && agents[0]) {
				setEditingId(agents[0].id);
				setForm(toForm(agents[0]));
				setPageState("agents", { editingId: agents[0].id, form: toForm(agents[0]) });
			}
		});
	};
	const loadAuth = (provider = selectedProvider) => {
		void apiGet<ProviderAuth>(`/settings/providers/${provider}/auth`).then(
			setAuth,
		);
	};
	useEffect(() => {
		load(!initialAgentsState.editingId);
		void apiGet<GlobalInstructions>("/settings/global-instructions").then(
			(data) => {
				if (!initialAgentsState.globalInstructions) setGlobalInstructions(data.text);
				setGlobalPath(data.path);
			},
		);
	}, []);
	useEffect(() => {
		loadAuth(selectedProvider);
	}, [selectedProvider]);
	useEffect(() => {
		if (form.thinking !== selectedThinking) {
			const next = { ...form, thinking: selectedThinking };
			setForm(next);
			setPageState("agents", { form: next });
		}
	}, [form, selectedThinking]);

	function patchForm(patch: Partial<AgentForm>) {
		const next = { ...form, ...patch };
		setForm(next);
		setPageState("agents", { form: next });
	}
	function chooseView(view: AgentsView) {
		setActiveView(view);
		setPageState("agents", { activeView: view });
	}

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
				temperature: Number(form.temperature ?? 0.2),
				name: form.name.trim(),
				provider: providerFromModel(form.model),
			};
			const saved = editingId
				? await apiPatch<AgentProfile>(`/agents/${editingId}`, body)
				: await apiPost<AgentProfile>("/agents", body);
			setEditingId(saved.id);
			setForm(toForm(saved));
			setPageState("agents", { editingId: saved.id, form: toForm(saved) });
			load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save agent");
		} finally {
			setSaving(false);
		}
	}

	async function saveGlobalInstructions() {
		setGlobalSaving(true);
		setError(null);
		try {
			const saved = await apiPatch<GlobalInstructions>(
				"/settings/global-instructions",
				{ text: globalInstructions },
			);
			setGlobalInstructions(saved.text);
			setPageState("agents", { globalInstructions: saved.text });
			setGlobalPath(saved.path);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to save global instructions",
			);
		} finally {
			setGlobalSaving(false);
		}
	}

	async function remove(id: string) {
		setError(null);
		await apiDelete(`/agents/${id}`);
		const remaining = items.filter((agent) => agent.id !== id);
		if (editingId === id) {
			const next = remaining[0];
			setEditingId(next?.id ?? null);
			setForm(next ? toForm(next) : defaultForm);
			setPageState("agents", { editingId: next?.id ?? null, form: next ? toForm(next) : defaultForm });
		}
		load();
	}

	function edit(agent: AgentProfile) {
		setEditingId(agent.id);
		setForm(toForm(agent));
		setPageState("agents", { editingId: agent.id, form: toForm(agent) });
		setError(null);
	}

	function newAgent() {
		setEditingId(null);
		setForm(defaultForm);
		setPageState("agents", { editingId: null, form: defaultForm });
		setError(null);
	}

	async function loginOpenAICodex() {
		setAuthBusy(true);
		setError(null);
		try {
			setAuth(await apiPost<ProviderAuth>("/settings/openai-codex/login", {}));
		} catch (err) {
			setError(err instanceof Error ? err.message : "OpenAI Codex login failed");
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
			setPageState("agents", { apiKey: "" });
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save API key");
		} finally {
			setAuthBusy(false);
		}
	}

	return (
		<section id="agents" className="card agents-page">
			<aside className="agents-sidebar">
				<div className="agents-sidebar-head">
					<div>
						<h2>Agents</h2>
						<p>Manage instructions, profiles, and auth.</p>
					</div>
				</div>
				<nav className="agents-nav" aria-label="Agents settings">
					<button
						type="button"
						className={activeView === "auth" ? "selected" : ""}
						onClick={() => chooseView("auth")}
					>
						Auth
					</button>
					<button
						type="button"
						className={activeView === "global" ? "selected" : ""}
						onClick={() => chooseView("global")}
					>
						Global Instructions
					</button>
					<button
						type="button"
						className={activeView === "agents" ? "selected" : ""}
						onClick={() => chooseView("agents")}
					>
						Agents
					</button>
				</nav>
				{activeView === "agents" ? (
					<>
						<div className="agents-sidebar-head compact">
							<strong>Profiles</strong>
							<button type="button" onClick={newAgent}>
								New
							</button>
						</div>
						<div className="agents-list" aria-label="Agents list">
							{items.length === 0 ? <p className="empty-state">No agents.</p> : null}
							{items.map((agent) => (
								<button
									key={agent.id}
									type="button"
									className={
										agent.id === editingId ? "agent-row selected" : "agent-row"
									}
									onClick={() => edit(agent)}
								>
									<strong>{agent.name}</strong>
									<small>{agent.model}</small>
									<span>thinking {agent.thinking ?? "off"}</span>
								</button>
							))}
						</div>
					</>
				) : null}
			</aside>

			<div className="agents-main">
				{activeView === "global" ? (
					<>
						<div className="agents-detail-head">
							<div>
								<h2>Global instructions</h2>
								<small>
									Stored at {globalPath}; prepended to every agent prompt.
								</small>
							</div>
							<div className="agents-actions">
								<button
									type="button"
									onClick={saveGlobalInstructions}
									disabled={globalSaving}
								>
									{globalSaving ? "Saving..." : "Save global instructions"}
								</button>
							</div>
						</div>
						<div className="agents-detail-scroll">
							<MarkdownEditor
								text={globalInstructions}
								onChange={(text) => { setGlobalInstructions(text); setPageState("agents", { globalInstructions: text }); }}
								placeholder="Global rules for all agents..."
								ariaLabel="Global instructions markdown editor"
							/>
							{error ? (
								<p role="alert" className="error">
									{error}
								</p>
							) : null}
						</div>
					</>
				) : null}

				{activeView === "auth" ? (
					<>
						<div className="agents-detail-head">
							<div>
								<h2>Auth</h2>
								<small>
									OpenAI Codex uses OAuth; Kimi and Z.AI use API keys.
								</small>
							</div>
						</div>
						<div className="agents-detail-scroll">
							<section className="agent-section">
								<h3>{selectedProvider}</h3>
								<p className="agent-auth-line">
									Status: {authStatus}
									{auth?.source ? ` via ${auth.source}` : null}
									{auth?.env ? ` (${auth.env})` : null}
								</p>
								<label>
									Provider / model context
									<select
										value={form.model}
										onChange={(e) => patchForm({ model: e.target.value })}
									>
										<option value="openai-codex/gpt-5.5">
											openai-codex / gpt-5.5
										</option>
										<option value="kimi-coding/k2p6">kimi-coding / k2p6</option>
										<option value="zai/glm-5.1">zai / glm-5.1</option>
									</select>
								</label>
								{needsOAuth ? (
									<button
										type="button"
										onClick={loginOpenAICodex}
										disabled={authBusy}
									>
										{authBusy ? "Waiting for OpenAI login..." : "Login with OpenAI"}
									</button>
								) : (
									<div className="agent-api-key-row">
										<input
											value={apiKey}
											onChange={(e) => { setApiKey(e.target.value); setPageState("agents", { apiKey: e.target.value }); }}
											placeholder={`${selectedProvider} API key`}
											type="password"
										/>
										<button type="button" onClick={saveApiKey} disabled={authBusy}>
											Save API key
										</button>
									</div>
								)}
								{auth?.login?.url && !auth.authenticated ? (
									<p>
										Login URL: <a href={auth.login.url}>{auth.login.url}</a>
									</p>
								) : null}
							</section>
							{error ? (
								<p role="alert" className="error">
									{error}
								</p>
							) : null}
						</div>
					</>
				) : null}

				{activeView === "agents" ? (
					<>
						<div className="agents-detail-head">
							<div>
								<h2>{editingId ? form.name || "Agent details" : "New agent"}</h2>
								<small>
									{selectedAgent
										? `Updated ${selectedAgent.updatedAt}`
										: "Unsaved profile"}
								</small>
							</div>
							<div className="agents-actions">
								{editingId ? (
									<button type="button" onClick={() => void remove(editingId)}>
										Delete
									</button>
								) : null}
								<button type="button" onClick={submit} disabled={!canSave}>
									{saving ? "Saving..." : editingId ? "Save changes" : "Create agent"}
								</button>
							</div>
						</div>

						<div className="agents-detail-scroll">
							<section className="agent-section">
								<h3>Profile</h3>
								<div className="agent-form-grid">
									<label>
										Name
										<input
											value={form.name}
											onChange={(e) => patchForm({ name: e.target.value })}
											placeholder="Agent name"
										/>
									</label>
									<label>
										Provider / model
										<select
											value={form.model}
											onChange={(e) => patchForm({ model: e.target.value })}
										>
											<option value="openai-codex/gpt-5.5">
												openai-codex / gpt-5.5
											</option>
											<option value="kimi-coding/k2p6">kimi-coding / k2p6</option>
											<option value="zai/glm-5.1">zai / glm-5.1</option>
										</select>
									</label>
								</div>
							</section>

							<section className="agent-section">
								<h3>Parameters</h3>
								<div className="agent-form-grid">
									<label>
										Thinking level
										<select
											value={selectedThinking}
											onChange={(e) =>
												patchForm({ thinking: e.target.value as ThinkingLevel })
											}
										>
											{thinkingOptions.map((level) => (
												<option key={level} value={level}>
													{level}
												</option>
											))}
										</select>
									</label>
									<label>
										Temperature: {Number(form.temperature ?? 0.2).toFixed(1)}
										<input
											type="range"
											min="0"
											max="2"
											step="0.1"
											value={form.temperature ?? 0.2}
											onChange={(e) =>
												patchForm({ temperature: Number(e.target.value) })
											}
										/>
									</label>
								</div>
							</section>

							<section className="agent-section agent-prompt-section">
								<h3>System prompt</h3>
								<MarkdownEditor
									text={form.systemPrompt}
									onChange={(systemPrompt) => patchForm({ systemPrompt })}
									placeholder="Agent-specific markdown prompt..."
									ariaLabel="System prompt markdown editor"
								/>
							</section>
							{duplicate ? <p role="alert">Agent name already exists.</p> : null}
							{error ? (
								<p role="alert" className="error">
									{error}
								</p>
							) : null}
						</div>
					</>
				) : null}
			</div>
		</section>
	);
}
