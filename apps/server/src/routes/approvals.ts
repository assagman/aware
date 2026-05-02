import { Hono } from "hono";
import { approve, requestApproval } from "../services/approvalService";

export const approvals = new Hono();
approvals.post("/request", async (c) => {
	const body = await c.req.json();
	return c.json({ approvalId: requestApproval(body.runId, body.command) });
});
approvals.post("/:id/approve", (c) =>
	c.json({ ok: approve(c.req.param("id")) }),
);
