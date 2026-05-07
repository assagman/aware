import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import {
	getProviderAuthStatus,
	saveProviderApiKey,
	startOpenAICodexLogin,
} from "../services/providerAuthService";
import { listAgentSkills } from "../services/skillCatalogService";

export const settings = new Hono();

const globalInstructionsPath = join(homedir(), ".agents", "AGENTS.md");

async function readGlobalInstructions() {
	try {
		return await readFile(globalInstructionsPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

settings.get("/global-instructions", async (c) =>
	c.json({
		path: globalInstructionsPath,
		text: await readGlobalInstructions(),
	}),
);

settings.patch("/global-instructions", async (c) => {
	try {
		const body = (await c.req.json()) as { text?: string };
		await mkdir(dirname(globalInstructionsPath), { recursive: true });
		await writeFile(globalInstructionsPath, body.text ?? "", "utf8");
		return c.json({ path: globalInstructionsPath, text: body.text ?? "" });
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to save global instructions";
		return c.json({ error: message }, 500);
	}
});

settings.get("/skills", async (c) => {
	const projectId = c.req.query("projectId");
	return c.json(await listAgentSkills(projectId ? { projectId } : {}));
});

settings.get("/models", async (c) =>
	c.json({
		primary: {
			provider: "openai-codex",
			model: "gpt-5.5",
			flueModel: "openai-codex/gpt-5.5",
			env: "OpenAI subscription OAuth login",
		},
		aliases: ["openai-codex/gpt-5.5", "kimi-coding/k2p6"],
		openaiCodex: {
			provider: "openai-codex",
			model: "gpt-5.5",
			flueModel: "openai-codex/gpt-5.5",
			env: "OpenAI subscription OAuth login",
		},
		fallback: {
			provider: "zai",
			model: "glm-5.1",
			flueModel: "zai/glm-5.1",
			env: "Z_AI_API_KEY or ZAI_API_KEY",
		},
		available: {
			openaiCodex: (await getProviderAuthStatus("openai-codex")).authenticated,
			kimi: (await getProviderAuthStatus("kimi-coding")).authenticated,
			zai: (await getProviderAuthStatus("zai")).authenticated,
		},
	}),
);

settings.get("/providers/:provider/auth", async (c) =>
	c.json(await getProviderAuthStatus(c.req.param("provider"))),
);

settings.post("/providers/:provider/api-key", async (c) => {
	try {
		const body = (await c.req.json()) as { key?: string };
		return c.json(
			await saveProviderApiKey(c.req.param("provider"), body.key ?? ""),
		);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to save API key";
		return c.json({ error: message }, 400);
	}
});

settings.post("/openai-codex/login", async (c) => {
	try {
		return c.json(await startOpenAICodexLogin());
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "OpenAI login failed";
		return c.json({ error: message }, 500);
	}
});
