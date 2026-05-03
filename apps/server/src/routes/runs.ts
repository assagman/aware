import type { AgentRun } from "@aware/shared";
import { Hono } from "hono";
import { db } from "../db/client";
import { flueRuntime } from "../services/agentRuntime/flueRuntime";

export const runs = new Hono();

runs.get("/", async (c) => {
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
	const run = (await db.list("runs")).find((r) => r.id === c.req.param("id"));
	return run ? c.json(run) : c.json({ error: "missing run" }, 404);
});

runs.post("/:id/cancel", async (c) => {
	const id = c.req.param("id");
	await db.update("runs", id, {
		status: "cancelled",
		endedAt: new Date().toISOString(),
	});
	return c.json({ ok: true });
});

runs.post("/:id/messages", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json();
	void flueRuntime.continueRun(id, body.message);
	return c.json({ ok: true });
});

runs.get("/:id/events", async (c) => {
	const id = c.req.param("id");
	const events = await db.list<{ id: string; runId: string; seq: number }>(
		"runEvents",
	);
	return c.json(
		events.filter((e) => e.runId === id).sort((a, b) => a.seq - b.seq),
	);
});

runs.get("/:id/stream", async (c) => {
	const id = c.req.param("id");
	const events = await db.list<{
		id: string;
		runId: string;
		type: string;
		payload: unknown;
	}>("runEvents");
	const body = events
		.filter((e) => e.runId === id)
		.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`)
		.join("");
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
});
