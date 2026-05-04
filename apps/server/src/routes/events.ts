import { Hono } from "hono";
import { worktreeWatchService } from "../services/worktreeWatchService";

export const events = new Hono();

events.get("/worktrees", async (c) => {
	await worktreeWatchService.watch(c.req.query("worktreeId") ?? "");
	const encoder = new TextEncoder();
	let cleanup: () => void = () => undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			const push = (text: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					close();
				}
			};
			const close = () => {
				if (closed) return;
				closed = true;
				unsubscribe();
				clearInterval(heartbeat);
				controller.close();
			};
			const unsubscribe = worktreeWatchService.subscribe((event) =>
				push(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
			);
			const heartbeat = setInterval(() => push(": heartbeat\n\n"), 15_000);
			cleanup = close;
			push(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
		},
		cancel() {
			cleanup();
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
		},
	});
});
