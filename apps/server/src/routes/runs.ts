import type { AgentRun, RunArtifact, Task } from "@aware/shared";
import { Hono } from "hono";
import { db } from "../db/client";
import { flueRuntime, runInactivityTimeoutMs } from "../services/agentRuntime/flueRuntime";
import {
	MAX_QUEUE_EVENTS,
	runEventHub,
} from "../services/agentRuntime/runEventHub";
import { allTaskRunsDone } from "../services/taskService";

export const runs = new Hono();

async function reconcileStaleRunningRuns() {
	const rows = await db.list<AgentRun>("runs");
	const events = await db.list("runEvents");
	const cutoff = Date.now() - runInactivityTimeoutMs();
	await Promise.all(
		rows
			.filter((run) => {
				if (run.status !== "running") return false;
				const latestEventAt = events
					.filter((event) => event.runId === run.id)
					.map((event) => new Date(String(event.createdAt)).getTime())
					.filter(Number.isFinite)
					.sort((a, b) => b - a)[0];
				return (latestEventAt ?? new Date(run.startedAt).getTime()) < cutoff;
			})
			.map(async (run) => {
				const endedAt = new Date().toISOString();
				await db.update<AgentRun>("runs", run.id, {
					status: "failed",
					endedAt,
				});
				await db.update("tasks", run.taskId, {
					status: "failed",
					updatedAt: endedAt,
				});
				await runEventHub.emit(
					run.id,
					"error",
					{ message: "[aware] Stale running session reconciled as failed." },
					{ immediate: true },
				);
			}),
	);
}

runs.get("/", async (c) => {
	await reconcileStaleRunningRuns();
	const worktreeId = c.req.query("worktreeId");
	const rows = await db.list<AgentRun>("runs");
	return c.json(
		rows
			.filter(
				(run) =>
					!worktreeId || worktreeId === "all" || run.worktreeId === worktreeId,
			)
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
	);
});

runs.get("/:id", async (c) => {
	await reconcileStaleRunningRuns();
	const run = (await db.list("runs")).find((r) => r.id === c.req.param("id"));
	return run ? c.json(run) : c.json({ error: "missing run" }, 404);
});

runs.get("/:id/task", async (c) => {
	await reconcileStaleRunningRuns();
	const run = (await db.list<AgentRun>("runs")).find((r) => r.id === c.req.param("id"));
	if (!run) return c.json({ error: "missing run" }, 404);
	const task = (await db.list<Task>("tasks")).find((row) => row.id === run.taskId);
	return task ? c.json(task) : c.json({ error: "missing task" }, 404);
});

runs.post("/:id/cancel", async (c) => {
	const id = c.req.param("id");
	const run = await db.update<AgentRun>("runs", id, {
		status: "cancelled",
		endedAt: new Date().toISOString(),
	});
	if (run)
		await db.update<Task>("tasks", run.taskId, {
			status: "failed",
			updatedAt: new Date().toISOString(),
		});
	return c.json({ ok: true });
});

runs.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const run = await db.update<AgentRun>("runs", id, {
		deletedAt: new Date().toISOString(),
	});
	return run ? c.json(run) : c.json({ error: "missing run" }, 404);
});

runs.post("/:id/done", async (c) => {
	const id = c.req.param("id");
	const run = (await db.list<AgentRun>("runs")).find((row) => row.id === id);
	if (!run) return c.json({ error: "missing run" }, 404);
	if (run.status === "running" || run.status === "queued")
		return c.json({ error: `run is ${run.status}` }, 409);
	const updated = await db.update<AgentRun>("runs", id, {
		status: "done",
		endedAt: run.endedAt ?? new Date().toISOString(),
	});
	if (await allTaskRunsDone(run.taskId)) {
		const task = (await db.list<Task>("tasks")).find((row) => row.id === run.taskId);
		if (task?.status !== "done")
			await db.update<Task>("tasks", run.taskId, {
				status: "need_review",
				updatedAt: new Date().toISOString(),
			});
	}
	return c.json(updated);
});

runs.post("/:id/messages", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	void flueRuntime.continueRun(id, body.message);
	return c.json({ ok: true });
});

runs.get("/:id/events", async (c) => {
	const id = c.req.param("id");
	return c.json(await runEventHub.persistedEvents(id));
});

runs.get("/:id/artifacts", async (c) => {
	const id = c.req.param("id");
	const rows = await db.list<RunArtifact>("runArtifacts");
	return c.json(
		rows
			.filter((artifact) => artifact.runId === id)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
	);
});

runs.get("/:id/stream", async (c) => {
	const id = c.req.param("id");
	const afterSeq = Number(
		c.req.query("afterSeq") ?? c.req.header("last-event-id") ?? -1,
	);
	await runEventHub.hydrateRun(id);
	const encoder = new TextEncoder();
	const encodeEvent = (event: {
		seq: number;
		type: string;
		payload: unknown;
	}) =>
		encoder.encode(
			`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`,
		);
	let cleanup: () => void = () => undefined;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let closed = false;
			let flushing = false;
			let unsubscribe: () => void = () => undefined;
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			const queue: Uint8Array[] = [];
			const close = () => {
				if (closed) return;
				closed = true;
				unsubscribe();
				if (heartbeat) clearInterval(heartbeat);
				controller.close();
			};
			cleanup = close;
			const flush = () => {
				if (flushing || closed) return;
				flushing = true;
				try {
					while (queue.length) controller.enqueue(queue.shift()!);
				} catch {
					close();
				} finally {
					flushing = false;
				}
			};
			const push = (chunk: Uint8Array) => {
				if (closed) return false;
				queue.push(chunk);
				if (queue.length > MAX_QUEUE_EVENTS) {
					close();
					return false;
				}
				queueMicrotask(flush);
				return true;
			};
			unsubscribe = runEventHub.subscribe(id, (event) =>
				push(encodeEvent(event)),
			);
			heartbeat = setInterval(
				() => push(encoder.encode(": heartbeat\n\n")),
				15_000,
			);
			for (const event of await runEventHub.persistedEvents(
				id,
				Number.isFinite(afterSeq) ? afterSeq : -1,
			)) {
				if (!push(encodeEvent(event))) break;
			}
		},
		cancel() {
			cleanup();
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
		},
	});
});
