import { Hono } from "hono";

export const settings = new Hono();

settings.get("/models", (c) =>
	c.json({
		primary: {
			provider: "openai-codex",
			model: "gpt-5.5",
			flueModel: "openai-codex/gpt-5.5",
			env: "OpenAI subscription OAuth login",
		},
		aliases: [
			"openai-codex/gpt-5.5",
			"kimi-coding/k2p6",
			"kimi-coding/kimi-for-coding",
		],
		fallback: {
			provider: "zai",
			model: "glm-5.1",
			flueModel: "zai/glm-5.1",
			env: "Z_AI_API_KEY or ZAI_API_KEY",
		},
		available: {
			openaiCodex: true,
			kimi: Boolean(process.env.KIMI_API_KEY),
			zai: Boolean(process.env.Z_AI_API_KEY || process.env.ZAI_API_KEY),
		},
	}),
);
