import { randomUUID } from "node:crypto";
import type {
	AgentProfile,
	AgentRun,
	Annotation,
	RunEvent,
	Task,
} from "@agent-ide/shared";
import {
	createFlueContext,
	InMemorySessionStore,
	resolveModel,
} from "@flue/sdk/internal";
import { db } from "../../db/client";
import { listAnnotations } from "../annotationService";
import { buildPrompt } from "./promptBuilder";

const now = () => new Date().toISOString();

function normalizeProviderEnv() {
	if (process.env.Z_AI_API_KEY && !process.env.ZAI_API_KEY) {
		process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
	}
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
		await this.log(run.id, "prompt", { text: prompt });
		try {
			const result = await this.runFlue(
				run,
				{ task, worktreePath: input.worktreePath, agents: input.agents },
				prompt,
			);
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

	private async runFlue(run: AgentRun, input: StartRunInput, prompt: string) {
		normalizeProviderEnv();
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
				defaultStore: new InMemorySessionStore(),
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
