import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { loginOpenAICodex } from "@mariozechner/pi-ai/oauth";
import { db } from "../db/client";

const execFileAsync = promisify(execFile);
const authPath = join(homedir(), ".pi", "agent", "auth.json");
const oauthProvider = "openai-codex";

const providerEnv: Record<string, string[]> = {
	"kimi-coding": ["KIMI_API_KEY"],
	zai: ["Z_AI_API_KEY", "ZAI_API_KEY"],
};

type AuthType = "oauth" | "api_key";
type AuthCredentialRow = {
	id: string;
	provider: string;
	type: AuthType;
	key?: string;
	credentials?: OAuthCredentials;
	createdAt: string;
	updatedAt: string;
};
type PiAuthCredential =
	| ({ type: "oauth" } & OAuthCredentials)
	| { type: "api_key"; key: string };
type PiAuth = Record<string, PiAuthCredential | unknown>;
type LoginState = {
	running: boolean;
	url?: string;
	error?: string;
	startedAt?: string;
};

let loginState: LoginState = { running: false };
const now = () => new Date().toISOString();

function readPiAuth(): PiAuth {
	if (!existsSync(authPath)) return {};
	return JSON.parse(readFileSync(authPath, "utf-8")) as PiAuth;
}

function writePiAuth(auth: PiAuth) {
	mkdirSync(dirname(authPath), { recursive: true });
	writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf-8");
}

function openUrl(url: string) {
	const command =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "cmd"
				: "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	void execFileAsync(command, args).catch(() => undefined);
}

async function getStoredCredential(provider: string) {
	return (await db.list<AuthCredentialRow>("authCredentials")).find(
		(row) => row.provider === provider,
	);
}

async function saveCredential(
	provider: string,
	credential: Pick<AuthCredentialRow, "type" | "key" | "credentials">,
) {
	const existing = await getStoredCredential(provider);
	const row: AuthCredentialRow = {
		id: existing?.id ?? provider,
		provider,
		type: credential.type,
		...(credential.key ? { key: credential.key } : {}),
		...(credential.credentials ? { credentials: credential.credentials } : {}),
		createdAt: existing?.createdAt ?? now(),
		updatedAt: now(),
	};
	await db.insert("authCredentials", row);
	const piAuth = readPiAuth();
	piAuth[provider] =
		row.type === "oauth" && row.credentials
			? { type: "oauth", ...row.credentials }
			: { type: "api_key", key: row.key ?? "" };
	writePiAuth(piAuth);
	return row;
}

function envSource(provider: string) {
	return providerEnv[provider]?.find((name) => Boolean(process.env[name]));
}

async function awaitLoginUrl(timeoutMs = 3000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (loginState.url || loginState.error) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

export async function getProviderAuthStatus(provider: string) {
	const stored = await getStoredCredential(provider);
	const env = envSource(provider);
	return {
		provider,
		authenticated: Boolean(stored || env),
		source: stored ? "stored" : env ? "environment" : undefined,
		type: stored?.type ?? (provider === oauthProvider ? "oauth" : "api_key"),
		env,
		path: authPath,
		login: provider === oauthProvider ? loginState : undefined,
	};
}

export async function saveProviderApiKey(provider: string, key: string) {
	const trimmed = key.trim();
	if (!trimmed) throw new Error("API key is required");
	await saveCredential(provider, { type: "api_key", key: trimmed });
	return getProviderAuthStatus(provider);
}

export async function startOpenAICodexLogin() {
	if (loginState.running) return getProviderAuthStatus(oauthProvider);
	loginState = { running: true, startedAt: now() };
	void loginOpenAICodex({
		onAuth: ({ url }) => {
			loginState = { ...loginState, url };
			openUrl(url);
		},
		onPrompt: async () => {
			throw new Error(
				"Browser callback required. If login fails, run `pi` then `/login openai-codex`.",
			);
		},
		onProgress: () => undefined,
	})
		.then(async (credentials) => {
			await saveCredential(oauthProvider, { type: "oauth", credentials });
			loginState = { running: false };
		})
		.catch((error) => {
			loginState = {
				running: false,
				error: error instanceof Error ? error.message : "OpenAI login failed",
			};
		});
	await awaitLoginUrl();
	return getProviderAuthStatus(oauthProvider);
}
