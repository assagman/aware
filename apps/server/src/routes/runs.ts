import { Hono } from "hono";
import { db } from "../db/client";

export const runs = new Hono();

runs.get("/", async (c) => {
	const rows = await db.list("runs");
	return c.json(rows.reverse());
});

runs.get("/:id", async (c) => {
	const run = (await db.list("runs")).find((r) => r.id === c.req.param("id"));
	return run ? c.json(run) : c.json({ error: "missing run" }, 404);
});

runs.get("/:id/events", async (c) => {
	const id = c.req.param("id");
	const events = await db.list<{ id: string; runId: string }>("runEvents");
	return c.json(events.filter((e) => e.runId === id));
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
