import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProfile, AgentRun, Annotation, Task } from "@aware/shared";
import { createFlueContext, resolveModel } from "@flue/sdk/internal";
import { db } from "../../db/client";
import { listAgentProfiles } from "../agentProfileService";
import { listAnnotations, markAnnotationsSent } from "../annotationService";
import { revertDefaultBranchMutation } from "../defaultBranchGuard";
import { worktreeRoot } from "../gitService";
import { assertAllowedWorktree, listProjects } from "../projectService";
import { getProviderRuntimeApiKey } from "../providerAuthService";
import { flueSessionStore } from "./flueSessionStore";
import { buildPrompt } from "./promptBuilder";
import { runEventHub } from "./runEventHub";

const now = () => new Date().toISOString();

function normalizeProviderEnv() {
	if (process.env.Z_AI_API_KEY && !process.env.ZAI_API_KEY) {
		process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
	}
}

function providerFromModel(model: string) {
	return model.split("/")[0] ?? "unknown";
}

function normalizeRuntimeThinking(thinking: string) {
	return thinking === "on" ? "medium" : thinking;
}

async function readGlobalAgentInstructions() {
	try {
		return (
			await readFile(join(homedir(), ".agents", "AGENTS.md"), "utf8")
		).trim();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return "";
		throw error;
	}
}

function agentProfileRoleInstructions(
	agentPrompt: string,
	globalInstructions: string,
) {
	return [
		globalInstructions
			? [
					"Global instructions from ~/.agents/AGENTS.md:",
					globalInstructions,
				].join("\n")
			: "",
		agentPrompt
			? ["Aware agent profile instructions:", agentPrompt].join("\n")
			: "",
	]
		.filter(Boolean)
		.join("\n\n");
}

type RuntimeSession = {
	harness?: {
		toolExecution?: "parallel" | "sequential";
		afterToolCall?: (context: {
			result?: { content?: unknown[]; details?: unknown };
			isError?: boolean;
		}) => Promise<unknown>;
		state?: { thinkingLevel?: string };
		subscribe?: (
			listener: (event: {
				type: string;
				assistantMessageEvent?: {
					type: string;
					delta?: string;
					content?: string;
				};
			}) => void | Promise<unknown>,
		) => void;
	};
};

function normalizeToolPath() {
	const home = process.env.HOME;
	const miseInstalls = home ? `${home}/.local/share/mise/installs` : "";
	const pathParts = [
		process.env.PATH ?? "",
		home ? `${home}/.local/bin` : "",
		home ? `${home}/.local/share/mise/shims` : "",
		miseInstalls ? `${miseInstalls}/node/24.11.1/bin` : "",
		miseInstalls ? `${miseInstalls}/bun/1.3.8/bin` : "",
		miseInstalls ? `${miseInstalls}/python/3.14.2/bin` : "",
		home ? `${home}/Library/pnpm` : "",
		home ? `${home}/.bun/bin` : "",
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	]
		.filter(Boolean)
		.flatMap((part) => part.split(":"));
	process.env.PATH = Array.from(new Set(pathParts)).join(":");
}

export type StartRunInput = {
	task: Task;
	worktreeId: string;
	worktreePath: string;
	agents: AgentProfile[];
};

export type StartChatInput = {
	projectId: string;
	worktreeId: string;
	worktreePath: string;
	agents: AgentProfile[];
	message: string;
	annotations: Annotation[];
	annotationIds?: string[];
	taskTitle?: string;
};

export class FlueRuntime {
	async startChat(input: StartChatInput): Promise<AgentRun> {
		const task: Task = {
			id: randomUUID(),
			projectId: input.projectId,
			worktreeId: input.worktreeId,
			title: input.taskTitle ?? "task",
			body: input.message,
			status: "running",
			createdAt: now(),
			updatedAt: now(),
		};
		const mainAgent = input.agents[0];
		const run: AgentRun = {
			id: randomUUID(),
			taskId: task.id,
			worktreeId: input.worktreeId,
			status: "running",
			sessionId: randomUUID(),
			...(mainAgent
				? {
						mainAgentProfileId: mainAgent.id,
						mainAgentName: mainAgent.name,
						mainAgentModel: mainAgent.model,
					}
				: {}),
			startedAt: now(),
		};
		await db.insert("tasks", task);
		await db.insert("runs", run);
		const prompt = buildPrompt({
			task,
			agents: input.agents,
			annotations: input.annotations,
			message: input.message,
		});
		await this.log(run.id, "user_message", { text: input.message });
		await this.log(run.id, "annotations", { annotations: input.annotations });
		await this.log(run.id, "prompt", { text: prompt });
		void this.executeRun(run, {
			task,
			worktreeId: input.worktreeId,
			worktreePath: input.worktreePath,
			agents: input.agents,
			prompt,
			annotationIds: input.annotationIds ?? input.annotations.map((a) => a.id),
		});
		return run;
	}

	private async executeRun(
		run: AgentRun,
		input: StartRunInput & { prompt: string; annotationIds?: string[] },
	) {
		try {
			const result = await this.runFlue(run, input, input.prompt);
			await this.flushLogs(run.id);
			const guardMessage = await this.guardDefaultBranch(input.worktreeId);
			if (guardMessage)
				this.log(
					run.id,
					"error",
					{ message: guardMessage },
					{ immediate: true },
				);
			this.log(run.id, "result", result, { immediate: true });
			await this.flushLogs(run.id);
			if (input.annotationIds?.length)
				await markAnnotationsSent(input.annotationIds);
			await db.update("runs", run.id, { status: "done", endedAt: now() });
			await db.update("tasks", input.task.id, {
				status: "done",
				updatedAt: now(),
			});
		} catch (error) {
			await this.log(run.id, "error", {
				message: error instanceof Error ? error.message : String(error),
			});
			await db.update("runs", run.id, { status: "failed", endedAt: now() });
			await db.update("tasks", input.task.id, {
				status: "failed",
				updatedAt: now(),
			});
		}
	}

	async startRun(input: StartRunInput): Promise<AgentRun> {
		const mainAgent = input.agents[0];
		const run: AgentRun = {
			id: randomUUID(),
			taskId: input.task.id,
			worktreeId: input.worktreeId,
			status: "running",
			sessionId: randomUUID(),
			...(mainAgent
				? {
						mainAgentProfileId: mainAgent.id,
						mainAgentName: mainAgent.name,
						mainAgentModel: mainAgent.model,
					}
				: {}),
			startedAt: now(),
		};
		await db.insert("runs", run);
		const prompt = buildPrompt({
			task: input.task,
			agents: input.agents,
			annotations: await listAnnotations({ taskId: input.task.id }),
		});
		await this.log(run.id, "prompt", { text: prompt });
		try {
			await db.update("tasks", input.task.id, {
				status: "running",
				updatedAt: now(),
			});
			const result = await this.runFlue(run, input, prompt);
			await this.flushLogs(run.id);
			const guardMessage = await this.guardDefaultBranch(input.worktreeId);
			if (guardMessage)
				this.log(
					run.id,
					"error",
					{ message: guardMessage },
					{ immediate: true },
				);
			this.log(run.id, "result", result, { immediate: true });
			await this.flushLogs(run.id);
			await db.update("runs", run.id, { status: "done", endedAt: now() });
			await db.update("tasks", input.task.id, {
				status: "done",
				updatedAt: now(),
			});
		} catch (error) {
			await this.log(run.id, "error", {
				message: error instanceof Error ? error.message : String(error),
			});
			await db.update("runs", run.id, { status: "failed", endedAt: now() });
			await db.update("tasks", input.task.id, {
				status: "failed",
				updatedAt: now(),
			});
		}
		return (
			(await db.list<AgentRun>("runs")).find((r) => r.id === run.id) ?? run
		);
	}

	async continueRun(runId: string, message: string) {
		const run = (await db.list<AgentRun>("runs")).find((r) => r.id === runId);
		if (!run) throw new Error("missing run");
		if (run.status !== "running") {
			await db.update<AgentRun>("runs", run.id, { status: "running" });
		}
		const worktree = await assertAllowedWorktree(run.worktreeId);
		const task = (await db.list<Task>("tasks")).find(
			(t) => t.id === run.taskId,
		);
		const agents = await listAgentProfiles();
		this.log(run.id, "user_message", { text: message }, { immediate: true });
		try {
			await db.update("tasks", task?.id ?? run.taskId, {
				status: "running",
				updatedAt: now(),
			});
			const result = await this.runFlue(
				run,
				{
					worktreeId: run.worktreeId,
					task: task ?? {
						id: run.taskId,
						projectId: "local",
						worktreeId: run.worktreeId,
						title: "Steering message",
						body: message,
						status: "running",
						createdAt: now(),
						updatedAt: now(),
					},
					worktreePath: worktree.path,
					agents,
				},
				message,
			);
			await this.flushLogs(run.id);
			const guardMessage = await this.guardDefaultBranch(run.worktreeId);
			if (guardMessage)
				this.log(
					run.id,
					"error",
					{ message: guardMessage },
					{ immediate: true },
				);
			this.log(run.id, "result", result, { immediate: true });
			await this.flushLogs(run.id);
			await db.update("runs", run.id, { status: "done", endedAt: now() });
			await db.update("tasks", task?.id ?? run.taskId, {
				status: "done",
				updatedAt: now(),
			});
		} catch (error) {
			await this.log(run.id, "error", {
				message: error instanceof Error ? error.message : String(error),
			});
			await db.update("runs", run.id, { status: "failed", endedAt: now() });
			await db.update("tasks", task?.id ?? run.taskId, {
				status: "failed",
				updatedAt: now(),
			});
		}
	}

	private async runFlue(run: AgentRun, input: StartRunInput, prompt: string) {
		normalizeProviderEnv();
		normalizeToolPath();
		const agent = input.agents[0];
		if (!agent) throw new Error("Create at least one agent profile first.");
		const provider = providerFromModel(agent.model);
		const globalInstructions = await readGlobalAgentInstructions();
		const runtimeApiKey = await getProviderRuntimeApiKey(provider);
		if (provider === "kimi-coding" && runtimeApiKey)
			process.env.KIMI_API_KEY = runtimeApiKey;
		if (provider === "zai" && runtimeApiKey)
			process.env.ZAI_API_KEY = runtimeApiKey;
		if (provider === "openai-codex" && runtimeApiKey)
			process.env.OPENAI_API_KEY = runtimeApiKey;
		await this.log(run.id, "model", {
			primary: agent.model,
			provider,
			thinking: agent.thinking ?? "off",
			fallback: "zai/glm-5.1",
			hasOpenAICodexAuth: provider === "openai-codex" && Boolean(runtimeApiKey),
			hasKimiKey: Boolean(process.env.KIMI_API_KEY),
			hasZaiKey: Boolean(process.env.ZAI_API_KEY),
			hasGlobalInstructions: Boolean(globalInstructions),
		});
		const { createDefaultEnv, createLocalEnv, createLocalWorktreeSandbox } =
			await import("../../flue/sandbox/localWorktreeSandbox");
		const project = (await listProjects()).find(
			(project) => project.id === input.task.projectId,
		);
		const workspaceRoot = await worktreeRoot(
			project?.rootPath ?? input.worktreePath,
		);
		const sandbox = await createLocalWorktreeSandbox({
			workspaceRoot,
			cwd: input.worktreePath,
		});
		const profileRole = "aware-agent-profile";
		const resolveRuntimeModel = (modelRef: string) => {
			const resolved = resolveModel(modelRef);
			return provider === "openai-codex" && runtimeApiKey
				? { ...resolved, provider: "openai" }
				: resolved;
		};
		const ctx = createFlueContext({
			id: run.id,
			payload: {},
			env: process.env,
			agentConfig: {
				systemPrompt: "",
				skills: {},
				roles: {
					[profileRole]: {
						name: profileRole,
						description: "Aware-selected agent profile instructions.",
						instructions: agentProfileRoleInstructions(
							agent.systemPrompt,
							globalInstructions,
						),
					},
				},
				model: undefined,
				resolveModel: resolveRuntimeModel,
			},
			createDefaultEnv,
			createLocalEnv,
			defaultStore: flueSessionStore,
		});
		ctx.setEventCallback((event) => {
			void this.log(run.id, event.type, event);
		});
		const model = process.env.KIMI_API_KEY
			? agent.model
			: process.env.ZAI_API_KEY
				? "zai/glm-5.1"
				: agent.model;
		const flueAgent = await ctx.init({
			sandbox,
			model,
			persist: flueSessionStore,
			role: profileRole,
		});
		const session = (await flueAgent.session(
			run.sessionId,
		)) as RuntimeSession & {
			prompt: (text: string) => Promise<unknown>;
		};
		this.configureSession(
			run,
			input.worktreeId,
			session,
			agent.thinking ?? "off",
		);
		return await session.prompt(prompt);
	}

	private configureSession(
		run: AgentRun,
		worktreeId: string,
		session: RuntimeSession,
		thinking: string,
	) {
		const harness = session.harness;
		if (!harness) return;
		harness.toolExecution = "parallel";
		if (harness.state)
			harness.state.thinkingLevel = normalizeRuntimeThinking(thinking);
		harness.subscribe?.((event) => {
			const assistantEvent = event.assistantMessageEvent;
			if (assistantEvent?.type === "thinking_delta" && assistantEvent.delta) {
				this.log(run.id, "thinking_delta", { text: assistantEvent.delta });
			}
		});
		harness.afterToolCall = async (context) => {
			const message = await this.guardDefaultBranch(worktreeId);
			if (!message) return undefined;
			const content = [
				...(context.result?.content ?? []),
				{ type: "text", text: message },
			];
			return {
				content,
				details: context.result?.details,
				isError: true,
			};
		};
	}

	private async guardDefaultBranch(worktreeId: string) {
		const worktree = await assertAllowedWorktree(worktreeId);
		return await revertDefaultBranchMutation(worktree);
	}

	log(
		runId: string,
		type: string,
		payload: unknown,
		options?: { immediate?: boolean },
	) {
		return runEventHub.emit(runId, type, payload, options);
	}

	async flushLogs(runId: string) {
		await runEventHub.flush(runId);
	}
}

export const flueRuntime = new FlueRuntime();
