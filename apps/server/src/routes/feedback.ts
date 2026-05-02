import { Hono } from "hono";
import { flueRuntime } from "../services/agentRuntime/flueRuntime";

export const feedback = new Hono();
feedback.post("/:runId", async (c) => {
	const body = await c.req.json();
	return c.json(await flueRuntime.log(c.req.param("runId"), "feedback", body));
});
