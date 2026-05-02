import { Hono } from "hono";
import {
	createAgentProfile,
	listAgentProfiles,
	updateAgentProfile,
} from "../services/agentProfileService";

export const agents = new Hono();
agents.get("/", async (c) => c.json(await listAgentProfiles()));
agents.post("/", async (c) =>
	c.json(await createAgentProfile(await c.req.json())),
);
agents.patch("/:id", async (c) =>
	c.json(await updateAgentProfile(c.req.param("id"), await c.req.json())),
);
