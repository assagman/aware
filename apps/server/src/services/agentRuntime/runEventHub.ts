import { randomUUID } from "node:crypto";
import type { RunEvent } from "@aware/shared";
import { db } from "../../db/client";

const now = () => new Date().toISOString();

type Subscriber = {
	id: string;
	enqueue: (event: RunEvent) => boolean;
};

type PendingBatch = {
	event: RunEvent;
	texts: string[];
	timer?: ReturnType<typeof setTimeout>;
};

const BATCH_FLUSH_MS = 300;
const MAX_PAYLOAD_CHARS = 80_000;
const MAX_DELTA_BATCH_CHARS = 24_000;
const MAX_QUEUE_EVENTS = 512;
const DELTA_TYPES = new Set(["text_delta", "thinking_delta"]);
const BOUNDARY_TYPES = new Set([
	"tool_end",
	"turn_end",
	"idle",
	"result",
	"error",
	"run_done",
	"run_failed",
]);

function secretValues() {
	return Object.entries(process.env)
		.filter(
			([key, value]) => value && /TOKEN|KEY|SECRET|PASSWORD|AUTH/i.test(key),
		)
		.map(([, value]) => String(value))
		.filter((value) => value.length >= 8);
}

function redactText(value: string) {
	let text = value;
	for (const secret of secretValues())
		text = text.split(secret).join("[REDACTED]");
	return text.length > MAX_PAYLOAD_CHARS
		? `${text.slice(0, MAX_PAYLOAD_CHARS)}…[truncated]`
		: text;
}

function sanitizePayload(payload: unknown): unknown {
	if (typeof payload === "string") return redactText(payload);
	if (payload == null || typeof payload !== "object") return payload;
	try {
		const json = redactText(JSON.stringify(payload));
		return JSON.parse(json) as unknown;
	} catch {
		return "[unserializable payload]";
	}
}

function payloadText(payload: unknown) {
	if (typeof payload === "string") return payload;
	if (!payload || typeof payload !== "object") return "";
	const value = payload as { text?: unknown; delta?: unknown };
	return typeof value.text === "string"
		? value.text
		: typeof value.delta === "string"
			? value.delta
			: "";
}

function batchedType(type: string) {
	return type === "thinking_delta"
		? "thinking_delta_batch"
		: "message_delta_batch";
}

export class RunEventHub {
	private seq = new Map<string, number>();
	private queues = new Map<string, Promise<unknown>>();
	private subscribers = new Map<string, Set<Subscriber>>();
	private pendingBatches = new Map<string, PendingBatch>();

	async hydrateRun(runId: string) {
		if (this.seq.has(runId)) return;
		const events = await this.persistedEvents(runId);
		this.seq.set(runId, Math.max(0, ...events.map((event) => event.seq)));
	}

	async persistedEvents(runId: string, afterSeq = -1) {
		const events = await db.list<RunEvent>("runEvents");
		return events
			.filter((event) => event.runId === runId && event.seq > afterSeq)
			.sort((a, b) => a.seq - b.seq);
	}

	emit(
		runId: string,
		type: string,
		payload: unknown,
		options?: { immediate?: boolean },
	) {
		const event: RunEvent = {
			id: randomUUID(),
			runId,
			seq: (this.seq.get(runId) ?? 0) + 1,
			type,
			payload: sanitizePayload(payload),
			createdAt: now(),
		};
		this.seq.set(runId, event.seq);
		this.broadcast(event);
		if (options?.immediate || !DELTA_TYPES.has(type))
			this.enqueuePersist(event);
		else this.queueDeltaBatch(event);
		if (BOUNDARY_TYPES.has(type)) void this.flush(runId);
		return event;
	}

	subscribe(runId: string, enqueue: (event: RunEvent) => boolean) {
		const subscriber = { id: randomUUID(), enqueue };
		const subscribers = this.subscribers.get(runId) ?? new Set<Subscriber>();
		subscribers.add(subscriber);
		this.subscribers.set(runId, subscribers);
		return () => {
			subscribers.delete(subscriber);
			if (!subscribers.size) this.subscribers.delete(runId);
		};
	}

	async flush(runId: string) {
		for (const [key, batch] of [...this.pendingBatches]) {
			if (!key.startsWith(`${runId}:`)) continue;
			this.flushBatch(key, batch);
		}
		const current = this.queues.get(runId);
		if (current) await current;
	}

	private broadcast(event: RunEvent) {
		const subscribers = this.subscribers.get(event.runId);
		if (!subscribers) return;
		for (const subscriber of [...subscribers]) {
			if (!subscriber.enqueue(event)) subscribers.delete(subscriber);
		}
	}

	private queueDeltaBatch(event: RunEvent) {
		const key = `${event.runId}:${event.type}`;
		const text = redactText(payloadText(event.payload));
		if (!text) return;
		const batch = this.pendingBatches.get(key) ?? {
			event: {
				...event,
				id: randomUUID(),
				type: batchedType(event.type),
				payload: { text: "" },
			},
			texts: [],
		};
		batch.texts.push(text);
		this.pendingBatches.set(key, batch);
		const size = batch.texts.join("").length;
		if (size >= MAX_DELTA_BATCH_CHARS) this.flushBatch(key, batch);
		else
			batch.timer ??= setTimeout(
				() => this.flushBatch(key, batch),
				BATCH_FLUSH_MS,
			);
	}

	private flushBatch(key: string, batch: PendingBatch) {
		if (batch.timer) clearTimeout(batch.timer);
		this.pendingBatches.delete(key);
		const text = batch.texts.join("");
		if (!text) return;
		this.enqueuePersist({
			...batch.event,
			payload: { text },
			createdAt: now(),
		});
	}

	private enqueuePersist(event: RunEvent) {
		const previous = this.queues.get(event.runId) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(() => db.insert("runEvents", event));
		this.queues.set(event.runId, next);
		void next.finally(() => {
			if (this.queues.get(event.runId) === next)
				this.queues.delete(event.runId);
		});
	}
}

export const runEventHub = new RunEventHub();
export { MAX_QUEUE_EVENTS };
