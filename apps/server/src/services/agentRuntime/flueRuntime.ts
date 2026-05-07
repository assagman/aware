import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AgentRun,
	Annotation,
	RunLane,
	RunRelation,
	RunStatus,
	Task,
} from "@aware/shared";
import { Type, type ToolDef } from "@flue/sdk/client";
import { createFlueContext, resolveModel } from "@flue/sdk/internal";
import { db } from "../../db/client";
import {
	ARTIFACTORY_TOOL_NAMES,
	resolveAgentTools,
	SKILL_TOOL_NAMES,
} from "../../flue/tools";
import { listAnnotations, markAnnotationsSent } from "../annotationService";
import {
	buildUpstreamArtifactContext,
	ensureSessionReportForTurn,
	nextSessionReportTurnSeq,
} from "../artifactoryService";
import { revertDefaultBranchMutation } from "../defaultBranchGuard";
import { worktreeRoot } from "../gitService";
import { assertAllowedWorktree, listProjects } from "../projectService";
import { listGraphAgentsForRun } from "../graphAgentService";
import { listGraphAutomationAgentsForRun } from "../graphAutomationAgentService";
import {
	listMainAgentsForRun,
	listShippingAgentsForRun,
} from "../shippingAgentService";
import { skillSandboxPolicy } from "../skillCatalogService";
import { ensureMutableWorktree } from "../worktreeAgentService";
import { getProviderRuntimeApiKey } from "../providerAuthService";
import { flueSessionStore } from "./flueSessionStore";
import {
	agentProfileInstructionsBlockTemplate,
	globalAgentInstructionsBlockTemplate,
	renderPromptTemplate,
	runInstructionsPrompt,
} from "../../prompts";
import { buildPrompt } from "./promptBuilder";
import { runEventHub } from "./runEventHub";
import { runtimeAgentRoleName, type RuntimeAgent } from "./runtimeAgent";

const now = () => new Date().toISOString();
const DEFAULT_RUN_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

function formatDuration(ms: number) {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds} seconds`;
	const minutes = Math.round(seconds / 60);
	return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function inactiveRunMessage(timeoutMs: number) {
	return [
		`No agent activity for ${formatDuration(timeoutMs)}.`,
		"Aware stopped this run because the agent runtime stopped emitting progress.",
		"Most likely cause: the model/provider stream hung or failed without returning an error.",
		"Retry the run; if it repeats, check provider auth/network status.",
	].join(" ");
}

export function runInactivityTimeoutMs() {
	const override = Number(process.env.AWARE_RUN_INACTIVITY_TIMEOUT_MS);
	return Number.isFinite(override) && override > 0
		? override
		: DEFAULT_RUN_INACTIVITY_TIMEOUT_MS;
}

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

export function agentProfileRoleInstructions(
	agentPrompt: string,
	globalInstructions: string,
) {
	return [
		runInstructionsPrompt,
		globalInstructions
			? renderPromptTemplate(globalAgentInstructionsBlockTemplate, {
					globalInstructions,
				})
			: "",
		agentPrompt
			? renderPromptTemplate(agentProfileInstructionsBlockTemplate, {
					agentPrompt,
				})
			: "",
	]
		.filter(Boolean)
		.join("\n\n");
}

type RuntimeTool = {
	name: string;
	description?: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<unknown>;
};

type RuntimeSession = {
	harness?: {
		toolExecution?: "parallel" | "sequential";
		prompt?: (text: string) => Promise<unknown>;
		afterToolCall?: (context: {
			result?: { content?: unknown[]; details?: unknown };
			isError?: boolean;
		}) => Promise<unknown>;
		state?: { thinkingLevel?: string; tools?: RuntimeTool[] };
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
	agents: RuntimeAgent[];
	message?: string;
	relation?: RunRelation;
	lane?: RunLane;
	parentRunId?: string;
	affectsTaskStatus?: boolean;
	completedStatus?: RunStatus;
	thoughtTargetRunId?: string;
	waitForCompletion?: boolean;
	suppressUpstreamArtifacts?: boolean;
};

export type StartChatInput = {
	projectId: string;
	worktreeId: string;
	worktreePath: string;
	agents: RuntimeAgent[];
	message: string;
	annotations: Annotation[];
	annotationIds?: string[];
	taskTitle?: string;
	taskSource?: Task["source"];
	lane?: RunLane;
	affectsTaskStatus?: boolean;
	completedStatus?: RunStatus;
};

export class FlueRuntime {
	private readonly activityListeners = new Map<string, Set<() => void>>();
	private readonly delegationUsage = new Map<string, number>();

	async startChat(input: StartChatInput): Promise<AgentRun> {
		const task: Task = {
			id: randomUUID(),
			projectId: input.projectId,
			worktreeId: input.worktreeId,
			title: input.taskTitle ?? "task",
			body: input.message,
			status: "running",
			...(input.taskSource ? { source: input.taskSource } : {}),
			...(input.annotationIds?.length
				? { annotationIds: input.annotationIds }
				: {}),
			createdAt: now(),
			updatedAt: now(),
		};
		const mainAgent = input.agents[0];
		const run: AgentRun = {
			id: randomUUID(),
			taskId: task.id,
			projectId: input.projectId,
			worktreeId: input.worktreeId,
			status: "running",
			sessionId: randomUUID(),
			...(input.lane ? { lane: input.lane } : {}),
			...(input.annotationIds?.length
				? { annotationIds: input.annotationIds }
				: {}),
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
		await this.log(run.id, "user_message", { text: prompt });
		await this.log(run.id, "annotations", { annotations: input.annotations });
		void this.executeRun(run, {
			task,
			worktreeId: input.worktreeId,
			worktreePath: input.worktreePath,
			agents: input.agents,
			prompt,
			annotationIds: input.annotationIds ?? input.annotations.map((a) => a.id),
			...(input.affectsTaskStatus !== undefined
				? { affectsTaskStatus: input.affectsTaskStatus }
				: {}),
			...(input.completedStatus
				? { completedStatus: input.completedStatus }
				: {}),
		});
		return run;
	}

	private async executeRun(
		run: AgentRun,
		input: StartRunInput & { prompt: string; annotationIds?: string[] },
	) {
		const affectsTaskStatus = input.affectsTaskStatus !== false;
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
			const finalStatus = input.completedStatus ?? "need_review";
			await db.update("runs", run.id, {
				status: finalStatus,
				endedAt: now(),
			});
			if (affectsTaskStatus)
				await db.update("tasks", input.task.id, {
					status: "need_review",
					updatedAt: now(),
				});
			if (finalStatus === "done") await this.activateQueuedSequentialChildren(run.id);
		} catch (error) {
			await this.log(run.id, "error", {
				message: error instanceof Error ? error.message : String(error),
			});
			await db.update("runs", run.id, { status: "failed", endedAt: now() });
			if (affectsTaskStatus)
				await db.update("tasks", input.task.id, {
					status: "failed",
					updatedAt: now(),
				});
		}
	}

	private async shouldQueueSequential(input: StartRunInput) {
		if ((input.relation ?? "parallel") !== "sequential" || !input.parentRunId)
			return false;
		const parent = (await db.list<AgentRun>("runs")).find(
			(run) => run.id === input.parentRunId && !run.deletedAt,
		);
		if (!parent) throw new Error("missing parent run");
		return parent.status !== "done";
	}

	private async startRunExecution(run: AgentRun, input: StartRunInput) {
		let activeRun = run;
		if (run.status !== "running") {
			const updatedRun = await db.update<AgentRun>("runs", run.id, {
				status: "running",
				startedAt: now(),
			});
			if (!updatedRun) throw new Error("missing run");
			activeRun = updatedRun;
		}
		const annotations = await listAnnotations({ taskId: input.task.id });
		const upstreamArtifacts = input.suppressUpstreamArtifacts
			? "(none)"
			: await buildUpstreamArtifactContext(activeRun);
		const prompt = buildPrompt({
			task: input.task,
			agents: input.agents,
			annotations,
			upstreamArtifacts,
			...(input.message ? { message: input.message } : {}),
		});
		await this.log(activeRun.id, "user_message", { text: prompt });
		if (input.affectsTaskStatus !== false)
			await db.update("tasks", input.task.id, {
				status: "running",
				updatedAt: now(),
			});
		const execution = this.executeRun(activeRun, {
			...input,
			prompt,
			annotationIds: annotations.map((annotation) => annotation.id),
		});
		if (input.waitForCompletion) await execution;
		else void execution;
	}

	async startRun(input: StartRunInput): Promise<AgentRun> {
		const mainAgent = input.agents[0];
		const queued = await this.shouldQueueSequential(input);
		const run: AgentRun = {
			id: randomUUID(),
			taskId: input.task.id,
			projectId: input.task.projectId,
			worktreeId: input.worktreeId,
			status: queued ? "queued" : "running",
			sessionId: randomUUID(),
			relation: input.relation ?? "parallel",
			...(input.lane ? { lane: input.lane } : {}),
			...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
			...(input.message ? { request: input.message } : {}),
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
		if (input.affectsTaskStatus !== false)
			await db.update("tasks", input.task.id, {
				status: "running",
				updatedAt: now(),
			});
		if (queued) {
			await this.log(run.id, "queued", {
				parentRunId: input.parentRunId,
				reason: "waiting for parent run to be marked done",
			});
			return run;
		}
		await this.startRunExecution(run, input);
		return run;
	}

	private async agentsForRun(run: AgentRun) {
		if (run.lane === "ship") return listShippingAgentsForRun();
		if (run.lane === "graph")
			return run.mainAgentProfileId && run.mainAgentProfileId !== "internal:graph-agent"
				? listGraphAutomationAgentsForRun()
				: listGraphAgentsForRun();
		return listMainAgentsForRun();
	}

	async activateQueuedSequentialChildren(parentRunId: string) {
		const runs = await db.list<AgentRun>("runs");
		const parent = runs.find((run) => run.id === parentRunId && !run.deletedAt);
		if (parent?.status !== "done") return;
		const queuedChildren = runs.filter(
			(run) =>
				!run.deletedAt &&
				run.status === "queued" &&
				run.relation === "sequential" &&
				run.parentRunId === parentRunId,
		);
		for (const child of queuedChildren) {
			const task = (await db.list<Task>("tasks")).find((row) => row.id === child.taskId);
			if (!task) continue;
			const worktree = await assertAllowedWorktree(child.worktreeId);
			await this.startRunExecution(child, {
				task,
				worktreeId: child.worktreeId,
				worktreePath: worktree.path,
				agents: await this.agentsForRun(child),
				...(child.request ? { message: child.request } : {}),
				relation: child.relation ?? "sequential",
				...(child.lane ? { lane: child.lane } : {}),
				...(child.parentRunId ? { parentRunId: child.parentRunId } : {}),
			});
		}
	}

	async markRunDoneAndActivateChildren(runId: string) {
		const run = (await db.list<AgentRun>("runs")).find((row) => row.id === runId);
		if (!run) return null;
		const updated = await db.update<AgentRun>("runs", runId, {
			status: "done",
			endedAt: run.endedAt ?? now(),
		});
		await this.activateQueuedSequentialChildren(runId);
		return updated;
	}

	async continueRun(runId: string, message: string) {
		const foundRun = (await db.list<AgentRun>("runs")).find(
			(r) => r.id === runId,
		);
		if (!foundRun) throw new Error("missing run");
		let run: AgentRun = foundRun;
		if (run.status !== "running") {
			const updatedRun = await db.update<AgentRun>("runs", run.id, {
				status: "running",
			});
			if (!updatedRun) throw new Error("missing run");
			run = updatedRun;
		}
		let worktree = await assertAllowedWorktree(run.worktreeId);
		const task = (await db.list<Task>("tasks")).find(
			(t) => t.id === run.taskId,
		);
		const project = (await listProjects()).find(
			(p) => p.id === (task?.projectId ?? worktree.projectId),
		);
		if (!project) throw new Error("missing project");
		const affectsTaskStatus = run.lane !== "graph";
		const reviewInvalidatedAt =
			affectsTaskStatus && task?.status === "done" ? now() : undefined;
		const mutableWorktree = affectsTaskStatus
			? await ensureMutableWorktree(project, worktree, {
					title: task?.title ?? "steering-message",
					body: message,
				})
			: worktree;
		if (mutableWorktree.id !== worktree.id) {
			worktree = mutableWorktree;
			const updatedRun = await db.update<AgentRun>("runs", run.id, {
				worktreeId: worktree.id,
			});
			if (!updatedRun) throw new Error("missing run");
			run = updatedRun;
			if (task && affectsTaskStatus)
				await db.update("tasks", task.id, { worktreeId: worktree.id });
			this.log(
				run.id,
				"worktree_switched",
				{
					worktreeId: worktree.id,
					path: worktree.path,
					branch: worktree.branch,
				},
				{ immediate: true },
			);
		}
		const agents = await this.agentsForRun(run);
		this.log(run.id, "user_message", { text: message }, { immediate: true });
		try {
			if (affectsTaskStatus)
				await db.update("tasks", task?.id ?? run.taskId, {
					status: "running",
					updatedAt: now(),
					...(reviewInvalidatedAt ? { reviewInvalidatedAt } : {}),
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
			const finalStatus = run.lane === "graph" ? "done" : "need_review";
			await db.update("runs", run.id, {
				status: finalStatus,
				endedAt: now(),
			});
			if (affectsTaskStatus)
				await db.update("tasks", task?.id ?? run.taskId, {
					status: "need_review",
					updatedAt: now(),
					...(reviewInvalidatedAt ? { reviewInvalidatedAt } : {}),
				});
			if (finalStatus === "done") await this.activateQueuedSequentialChildren(run.id);
		} catch (error) {
			await this.log(run.id, "error", {
				message: error instanceof Error ? error.message : String(error),
			});
			await db.update("runs", run.id, { status: "failed", endedAt: now() });
			if (affectsTaskStatus)
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
		const isThoughtAgent = agent.roleName === "thought-agent";
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
		const skillsContext = agent.skillsEnabled === false
			? undefined
			: {
					projectId: input.task.projectId,
					workspacePath: input.worktreePath,
					agent,
				};
		const skillPolicy = await skillSandboxPolicy({
			projectId: input.task.projectId,
			workspacePath: input.worktreePath,
			agent,
		});
		const sandbox = await createLocalWorktreeSandbox({
			workspaceRoot,
			cwd: input.worktreePath,
			...skillPolicy,
		});
		const profileRole = "aware-agent-profile";
		const availableAgents = input.agents.slice(1);
		const availableAgentRoles = availableAgents.map(runtimeAgentRoleName);
		const roles = Object.fromEntries([
			[
				profileRole,
				{
					name: profileRole,
					description: "Aware-selected agent profile instructions.",
					instructions: agentProfileRoleInstructions(
						agent.systemPrompt,
						globalInstructions,
					),
				},
			],
			...availableAgents.map((availableAgent) => [
				runtimeAgentRoleName(availableAgent),
				{
					name: runtimeAgentRoleName(availableAgent),
					description:
						availableAgent.description ??
						`${availableAgent.name} instructions.`,
					instructions: agentProfileRoleInstructions(
						availableAgent.systemPrompt,
						globalInstructions,
					),
				},
			]),
		]);
		const resolveRuntimeModel: typeof resolveModel = (
			modelConfig,
			providers,
		) => {
			const resolved = resolveModel(modelConfig, providers);
			return resolved && provider === "openai-codex" && runtimeApiKey
				? { ...resolved, provider: "openai" }
				: resolved;
		};
		const ctx = createFlueContext({
			id: run.id,
			payload: {},
			env: process.env,
			agentConfig: {
				systemPrompt: runInstructionsPrompt,
				skills: {},
				roles,
				model: undefined,
				resolveModel: resolveRuntimeModel,
			},
			createDefaultEnv,
			createLocalEnv,
			defaultStore: flueSessionStore,
		});
		let onRuntimeActivity: () => void = () => undefined;
		let currentTurnSeq = await nextSessionReportTurnSeq(run.id);
		let turnEndQueue = Promise.resolve();
		const queueTurnEndReport = (turnSeq: number) => {
			turnEndQueue = turnEndQueue.then(async () => {
				try {
					await ensureSessionReportForTurn({ run, task: input.task, turnSeq });
				} catch (error) {
					this.log(
						run.id,
						"artifact_error",
						{
							message: error instanceof Error ? error.message : String(error),
							turnSeq,
						},
						{ immediate: true },
					);
				}
			});
		};
		ctx.setEventCallback((event) => {
			onRuntimeActivity();
			void this.log(run.id, event.type, event);
			if (event.type === "turn_end" && !isThoughtAgent) {
				const turnSeq = currentTurnSeq;
				currentTurnSeq += 1;
				queueTurnEndReport(turnSeq);
			}
		});
		const model = process.env.KIMI_API_KEY
			? agent.model
			: process.env.ZAI_API_KEY
				? "zai/glm-5.1"
				: agent.model;
		const agentTools = [
			...resolveAgentTools(agent.tools, {
				...(isThoughtAgent
					? { thought: { runId: input.thoughtTargetRunId ?? run.id } }
					: {
							artifactory: { run, task: input.task, turnSeq: () => currentTurnSeq },
							...(skillsContext ? { skills: skillsContext } : {}),
						}),
			}),
			...this.createScopedDelegationTools(run, input, availableAgents),
		];
		const flueAgent = await ctx.init({
			sandbox,
			model,
			persist: flueSessionStore,
			role: profileRole,
			tools: agentTools,
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
			agent,
			availableAgentRoles,
		);
		const delegationKey = this.delegationUsageKey(run, agent);
		try {
			const result = await this.withInactivityTimeout(
				run.id,
				() => session.prompt(prompt),
				(listener) => {
					onRuntimeActivity = listener;
				},
			);
			await turnEndQueue;
			this.assertDelegationPolicy(run, agent);
			return result;
		} finally {
			this.delegationUsage.delete(delegationKey);
		}
	}

	private delegationUsageKey(run: AgentRun, agent: RuntimeAgent) {
		return `${run.id}:${run.sessionId}:${agent.id}:delegate_agent`;
	}

	private exactDelegationMessage(agent: RuntimeAgent) {
		const role = agent.delegationPolicy?.requiredRole;
		return role
			? `delegate_agent must be called exactly once with role \`${role}\`.`
			: "delegate_agent must be called exactly once.";
	}

	private assertDelegationPolicy(run: AgentRun, agent: RuntimeAgent) {
		const policy = agent.delegationPolicy;
		if (!policy?.minCalls) return;
		const count = this.delegationUsage.get(this.delegationUsageKey(run, agent)) ?? 0;
		if (count < policy.minCalls) throw new Error(this.exactDelegationMessage(agent));
	}

	private createScopedDelegationTools(
		run: AgentRun,
		input: StartRunInput,
		availableAgents: RuntimeAgent[],
	): ToolDef[] {
		const selectedAgent = input.agents[0];
		if (!selectedAgent?.tools.includes("delegate_agent")) return [];
		const policy = selectedAgent.delegationPolicy;
		const usageKey = this.delegationUsageKey(run, selectedAgent);
		if (policy) this.delegationUsage.set(usageKey, this.delegationUsage.get(usageKey) ?? 0);
		const agentsByRole = new Map(
			availableAgents.map((agent) => [runtimeAgentRoleName(agent), agent]),
		);
		const availableRoles = Array.from(agentsByRole.keys());
		const availableText = availableRoles.length ? availableRoles.join(", ") : "(none)";
		return [
			{
				name: "delegate_agent",
				description: [
					"Delegate to one explicitly available scoped Aware agent with that agent's own prompt, tool allow-list, and skill policy.",
					`Available agents: ${availableText}.`,
					"Use this instead of built-in task delegation when strict agent/tool separation is required.",
				].join(" "),
				parameters: Type.Object({
					description: Type.Optional(Type.String({ description: "Short human-readable label for the delegated work." })),
					prompt: Type.String({ description: "Complete instructions for the delegated agent." }),
					role: Type.String({ description: "Exact available role to delegate to." }),
				}),
				execute: async (args) => {
					const role = typeof args.role === "string" ? args.role.trim() : "";
					const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
					if (!role) throw new Error(`delegate_agent requires role. Available agents: ${availableText}.`);
					if (!prompt) throw new Error("delegate_agent requires prompt.");
					if (policy?.requiredRole && role !== policy.requiredRole)
						throw new Error(`delegate_agent must use role \`${policy.requiredRole}\`.`);
					const count = this.delegationUsage.get(usageKey) ?? 0;
					if (policy?.maxCalls !== undefined && count >= policy.maxCalls)
						throw new Error(this.exactDelegationMessage(selectedAgent));
					const agent = agentsByRole.get(role);
					if (!agent) throw new Error(`Agent role "${role}" is not available. Available agents: ${availableText}.`);
					this.delegationUsage.set(usageKey, count + 1);
					const result = await this.runDelegatedAgent(run, input, agent, prompt);
					return this.delegatedAgentResultText(result);
				},
			},
		];
	}

	private async runDelegatedAgent(
		parentRun: AgentRun,
		input: StartRunInput,
		agent: RuntimeAgent,
		prompt: string,
	) {
		const taskId = randomUUID();
		const role = runtimeAgentRoleName(agent);
		this.log(parentRun.id, "task_start", {
			taskId,
			prompt,
			role,
			parentSessionId: parentRun.sessionId,
		}, { immediate: true });
		const delegatedRun: AgentRun = {
			...parentRun,
			sessionId: `${parentRun.sessionId}-delegate-${taskId}`,
			mainAgentProfileId: agent.id,
			mainAgentName: agent.name,
			mainAgentModel: agent.model,
		};
		try {
			const result = await this.runFlue(
				delegatedRun,
				{
					...input,
					agents: [agent],
				},
				prompt,
			);
			this.log(parentRun.id, "task_end", {
				taskId,
				isError: false,
				result: this.delegatedAgentResultText(result),
				parentSessionId: parentRun.sessionId,
			}, { immediate: true });
			return result;
		} catch (error) {
			this.log(parentRun.id, "task_end", {
				taskId,
				isError: true,
				result: error instanceof Error ? error.message : String(error),
				parentSessionId: parentRun.sessionId,
			}, { immediate: true });
			throw error;
		}
	}

	private delegatedAgentResultText(result: unknown) {
		if (typeof result === "string") return result;
		if (result && typeof result === "object" && "text" in result) {
			const text = (result as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) return text;
		}
		return JSON.stringify(result, null, 2);
	}

	private async withInactivityTimeout<T>(
		runId: string,
		operation: () => Promise<T>,
		setActivityListener: (listener: () => void) => void,
	) {
		const timeoutMs = runInactivityTimeoutMs();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let rejectInactive: ((error: Error) => void) | undefined;
		const reset = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(
				() => rejectInactive?.(new Error(inactiveRunMessage(timeoutMs))),
				timeoutMs,
			);
		};
		setActivityListener(reset);
		const listeners = this.activityListeners.get(runId) ?? new Set<() => void>();
		listeners.add(reset);
		this.activityListeners.set(runId, listeners);
		reset();
		try {
			return await Promise.race([
				operation(),
				new Promise<never>((_, reject) => {
					rejectInactive = reject;
				}),
			]);
		} finally {
			listeners.delete(reset);
			if (!listeners.size) this.activityListeners.delete(runId);
			if (timer) clearTimeout(timer);
			setActivityListener(() => undefined);
		}
	}

	private guardAgentDelegationTool(
		tools: RuntimeTool[] | undefined,
		availableAgentRoles: string[],
	) {
		const taskTool = tools?.find((tool) => tool.name === "task");
		if (!taskTool) return;
		const available = new Set(availableAgentRoles);
		const availableText = availableAgentRoles.length
			? availableAgentRoles.join(", ")
			: "(none)";
		const originalExecute = taskTool.execute.bind(taskTool);
		taskTool.description = [
			"Delegate to an available Aware agent. You must pass one exact role value; omitting role is blocked to prevent Main/current-agent recursion.",
			`Available agents: ${availableText}.`,
			"Use role `shipping-agent` for final shipping operations: rebase, push, PR creation, and PR merge.",
		].join(" ");
		taskTool.execute = async (toolCallId, params, signal) => {
			const role = typeof params.role === "string" ? params.role.trim() : "";
			if (!role)
				throw new Error(
					`Agent delegation requires explicit role. Available agents: ${availableText}. Main/current agent is not delegable.`,
				);
			if (!available.has(role))
				throw new Error(
					`Agent role "${role}" is not available. Available agents: ${availableText}. Main/current agent is blocked to prevent recursion.`,
				);
			return originalExecute(toolCallId, { ...params, role }, signal);
		};
	}

	private applyRuntimeToolPolicy(
		tools: RuntimeTool[] | undefined,
		agent: RuntimeAgent,
		availableAgentRoles: string[],
	) {
		const alwaysAllowed = new Set<string>([
			...ARTIFACTORY_TOOL_NAMES,
			...(agent.skillsEnabled === false ? [] : SKILL_TOOL_NAMES),
		]);
		const filtered = agent.allowedToolNames
			? tools?.filter(
					(tool) =>
						agent.allowedToolNames?.includes(tool.name) ||
						alwaysAllowed.has(tool.name),
				)
			: tools;
		this.guardAgentDelegationTool(filtered, availableAgentRoles);
		return filtered;
	}

	private configureSession(
		run: AgentRun,
		worktreeId: string,
		session: RuntimeSession,
		agent: RuntimeAgent,
		availableAgentRoles: string[],
	) {
		const harness = session.harness;
		if (!harness) return;
		harness.toolExecution = agent.toolExecution ?? "parallel";
		if (harness.state) {
			harness.state.thinkingLevel = normalizeRuntimeThinking(
				agent.thinking ?? "off",
			);
			const tools = this.applyRuntimeToolPolicy(
				harness.state.tools,
				agent,
				availableAgentRoles,
			);
			if (tools) harness.state.tools = tools;
		}
		if (harness.prompt) {
			const originalPrompt = harness.prompt.bind(harness);
			harness.prompt = async (text) => {
				if (harness.state) {
					const tools = this.applyRuntimeToolPolicy(
						harness.state.tools,
						agent,
						availableAgentRoles,
					);
					if (tools) harness.state.tools = tools;
				}
				return originalPrompt(text);
			};
		}
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
		for (const listener of this.activityListeners.get(runId) ?? []) listener();
		return runEventHub.emit(runId, type, payload, options);
	}

	async flushLogs(runId: string) {
		await runEventHub.flush(runId);
	}
}

export const flueRuntime = new FlueRuntime();
