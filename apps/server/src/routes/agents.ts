import { Hono } from "hono";
import type { Context } from "hono";
import {
	createAgentProfile,
	deleteAgentProfile,
	listAgentProfiles,
	updateAgentProfile,
} from "../services/agentProfileService";

export const agents = new Hono();

function errorResponse(c: Context, error: unknown) {
	const message = error instanceof Error ? error.message : "Unknown error";
	const status = message.includes("name") ? 400 : 500;
	return c.json({ error: message }, status);
}

agents.get("/", async (c) => c.json(await listAgentProfiles()));
agents.post("/", async (c) => {
	try {
		return c.json(await createAgentProfile(await c.req.json()));
	} catch (error) {
		return errorResponse(c, error);
	}
});
agents.patch("/:id", async (c) => {
	try {
		const agent = await updateAgentProfile(
			c.req.param("id"),
			await c.req.json(),
		);
		if (!agent) return c.json({ error: "Agent not found" }, 404);
		return c.json(agent);
	} catch (error) {
		return errorResponse(c, error);
	}
});
agents.delete("/:id", async (c) => {
	await deleteAgentProfile(c.req.param("id"));
	return c.body(null, 204);
});
