import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

function portFromEnv(value: string | undefined, fallback: number) {
	const port = Number(value);
	return Number.isInteger(port) && port > 0 ? port : fallback;
}

function packageName(id: string) {
	const normalized = id.replaceAll("\\", "/");
	const afterNodeModules = normalized.split("/node_modules/").pop() ?? "";
	const [scopeOrName, name] = afterNodeModules.split("/");
	return scopeOrName?.startsWith("@") ? `${scopeOrName}/${name ?? ""}` : (scopeOrName ?? "");
}

function manualChunks(id: string) {
	if (!id.includes("node_modules")) return undefined;
	const normalized = id.replaceAll("\\", "/");
	const pkg = packageName(id);
	if (pkg === "@xyflow/react" || pkg.startsWith("d3-") || pkg === "zustand") return "vendor-graph";
	if (pkg.startsWith("@mdxeditor/")) return "vendor-mdxeditor";
	if (pkg === "react" || pkg === "react-dom" || pkg === "scheduler") return "vendor-react";
	if (pkg === "react-markdown" || pkg.startsWith("remark-") || pkg.startsWith("rehype-") || pkg.startsWith("micromark") || pkg === "unified" || pkg.includes("mdast") || pkg.includes("hast") || pkg.startsWith("vfile")) return "vendor-markdown";
	if (pkg === "shiki" || pkg === "@shikijs/core" || pkg === "@shikijs/engine-javascript" || pkg === "@shikijs/types" || pkg === "@shikijs/vscode-textmate" || pkg === "oniguruma-to-es") return "vendor-shiki";
	if (pkg === "@pierre/trees") return "vendor-trees";
	if (normalized.includes("/mdast") || normalized.includes("/hast")) return "vendor-markdown";
	return undefined;
}

export default defineConfig(({ mode }) => {
	const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
	const apiPort = portFromEnv(env.API_PORT ?? env.PORT, 8787);
	const webPort = portFromEnv(env.WEB_PORT, 5173);

	return {
		plugins: [react()],
		server: {
			host: "127.0.0.1",
			port: webPort,
			strictPort: Boolean(env.WEB_PORT),
			proxy: {
				"/api": env.AWARE_API_ORIGIN ?? `http://127.0.0.1:${apiPort}`,
			},
		},
		build: {
			rollupOptions: {
				output: { manualChunks },
			},
		},
	};
});
