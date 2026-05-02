import { randomUUID } from "node:crypto";
import type {
	AgentProfile,
	AgentRun,
	Annotation,
	RunEvent,
	Task,
} from "@agent-ide/shared";
import { createFlueContext, resolveModel } from "@flue/sdk/internal";
import { db } from "../../db/client";
import { listAgentProfiles } from "../agentProfileService";
import { listAnnotations, markAnnotationsSent } from "../annotationService";
import { assertAllowedWorktree } from "../projectService";
import { flueSessionStore } from "./flueSessionStore";
import { buildPrompt } from "./promptBuilder";

const now = () => new Date().toISOString();

function normalizeProviderEnv() {
	if (process.env.Z_AI_API_KEY && !process.env.ZAI_API_KEY) {
		process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
	}
}

function normalizeToolPath() {
	const home = process.env.HOME;
	const miseInstalls = home ? `${home}/.local/share/mise/installs` : "";
	const pathParts = [
		process.env.PATH ?? "",
		home ? `${home}/.local/share/mise/shims` : "",
		miseInstalls ? `${miseInstalls}/bun/1.3.8/bin` : "",
		miseInstalls ? `${miseInstalls}/python/3.14.2/bin` : "",
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
};

export class FlueRuntime {
	async startChat(input: StartChatInput): Promise<AgentRun> {
		const task: Task = {
			id: randomUUID(),
			projectId: input.projectId,
			worktreeId: input.worktreeId,
			title: "Direct chat",
			body: input.message,
			status: "running",
			createdAt: now(),
			updatedAt: now(),
		};
		const run: AgentRun = {
			id: randomUUID(),
			taskId: task.id,
			worktreeId: input.worktreeId,
			status: "running",
			sessionId: randomUUID(),
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
			await this.log(run.id, "result", result);
			if (input.annotationIds?.length)
				await markAnnotationsSent(input.annotationIds);
			await db.update("runs", run.id, { status: "done", endedAt: now() });
		} catch (error) {
			await this.log(run.id, "error", {
				message: error instanceof Error ? error.message : String(error),
			});
			await db.update("runs", run.id, { status: "failed", endedAt: now() });
		}
	}

	async startRun(input: StartRunInput): Promise<AgentRun> {
		const run: AgentRun = {
			id: randomUUID(),
			taskId: input.task.id,
			worktreeId: input.task.worktreeId,
			status: "running",
			sessionId: randomUUID(),
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
			const result = await this.runFlue(run, input, prompt);
			await this.log(run.id, "result", result);
			await db.update("runs", run.id, { status: "done", endedAt: now() });
		} catch (error) {
			await this.log(run.id, "error", {
				message: error instanceof Error ? error.message : String(error),
			});
			await db.update("runs", run.id, { status: "failed", endedAt: now() });
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
		await this.log(run.id, "user_message", { text: message });
		try {
			const result = await this.runFlue(
				run,
				{
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
			await this.log(run.id, "result", result);
			await db.update("runs", run.id, { status: "done", endedAt: now() });
		} catch (error) {
			await this.log(run.id, "error", {
				message: error instanceof Error ? error.message : String(error),
			});
			await db.update("runs", run.id, { status: "failed", endedAt: now() });
		}
	}

	private async runFlue(run: AgentRun, input: StartRunInput, prompt: string) {
		normalizeProviderEnv();
		normalizeToolPath();
		const agent = input.agents[0];
		if (!agent) throw new Error("Create at least one agent profile first.");
		await this.log(run.id, "model", {
			primary: agent.model,
			fallback: "zai/glm-5.1",
			hasKimiKey: Boolean(process.env.KIMI_API_KEY),
			hasZaiKey: Boolean(process.env.ZAI_API_KEY),
		});
		const previous = process.cwd();
		process.chdir(input.worktreePath);
		try {
			const { createDefaultEnv, createLocalEnv } = await import(
				"../../flue/sandbox/localWorktreeSandbox"
			);
			const ctx = createFlueContext({
				id: run.id,
				payload: {},
				env: process.env,
				agentConfig: {
					systemPrompt: agent.systemPrompt,
					skills: {},
					roles: {},
					model: undefined,
					resolveModel,
				},
				createDefaultEnv,
				createLocalEnv,
				defaultStore: flueSessionStore,
			});
			ctx.setEventCallback((event) => void this.log(run.id, event.type, event));
			const model = process.env.KIMI_API_KEY
				? agent.model
				: process.env.ZAI_API_KEY
					? "zai/glm-5.1"
					: agent.model;
			const flueAgent = await ctx.init({
				sandbox: "local",
				model,
				persist: flueSessionStore,
			});
			const session = await flueAgent.session(run.sessionId);
			return await session.prompt(prompt);
		} finally {
			process.chdir(previous);
		}
	}

	async log(runId: string, type: string, payload: unknown) {
		const events = await db.list<RunEvent>("runEvents");
		const event: RunEvent = {
			id: randomUUID(),
			runId,
			seq: events.filter((e) => e.runId === runId).length,
			type,
			payload,
			createdAt: now(),
		};
		await db.insert("runEvents", event);
		return event;
	}
}

export const flueRuntime = new FlueRuntime();
