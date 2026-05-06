import { Hono } from "hono";
import { buildGraphProjection } from "../services/graph/projection";

export const graph = new Hono();

graph.get("/", async (c) => c.json(await buildGraphProjection()));
