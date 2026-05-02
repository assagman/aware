import { Hono } from "hono";

export const settings = new Hono();

settings.get("/models", (c) =>
	c.json({
		primary: {
			provider: "kimi-coding",
			model: "k2p6",
			flueModel: "kimi-coding/k2p6",
			env: "KIMI_API_KEY",
		},
		aliases: ["kimi-coding/k2p6", "kimi-coding/kimi-for-coding"],
		fallback: {
			provider: "zai",
			model: "glm-5.1",
			flueModel: "zai/glm-5.1",
			env: "Z_AI_API_KEY or ZAI_API_KEY",
		},
		available: {
			kimi: Boolean(process.env.KIMI_API_KEY),
			zai: Boolean(process.env.Z_AI_API_KEY || process.env.ZAI_API_KEY),
		},
	}),
);
