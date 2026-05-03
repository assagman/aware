import type { RunEvent } from "@agent-ide/shared";

type Listener = (event: RunEvent) => void;

const listenersByRun = new Map<string, Set<Listener>>();

export function subscribeRunEvents(runId: string, listener: Listener) {
	const listeners = listenersByRun.get(runId) ?? new Set<Listener>();
	listeners.add(listener);
	listenersByRun.set(runId, listeners);
	return () => {
		listeners.delete(listener);
		if (!listeners.size) listenersByRun.delete(runId);
	};
}

export function publishRunEvent(event: RunEvent) {
	const listeners = listenersByRun.get(event.runId);
	if (!listeners) return;
	for (const listener of listeners) listener(event);
}
