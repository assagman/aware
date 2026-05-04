import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

function portFromEnv(value: string | undefined, fallback: number) {
	const port = Number(value);
	return Number.isInteger(port) && port > 0 ? port : fallback;
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
	};
});
