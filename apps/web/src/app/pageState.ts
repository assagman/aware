const PREFIX = "aware-page-state:";

export function getPageState<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(`${PREFIX}${key}`);
		return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
	} catch {
		return fallback;
	}
}

export function setPageState<T extends Record<string, unknown>>(
	key: string,
	patch: Partial<T>,
) {
	const current = getPageState<T>(key, {} as T);
	localStorage.setItem(
		`${PREFIX}${key}`,
		JSON.stringify({ ...current, ...patch }),
	);
}

export function restoreScroll(key: string, element: HTMLElement | null) {
	if (!element) return;
	const state = getPageState<{ scrollTop: number }>(key, { scrollTop: 0 });
	element.scrollTop = state.scrollTop || 0;
}

export function persistScroll(key: string, element: HTMLElement | null) {
	if (!element) return;
	setPageState(key, { scrollTop: element.scrollTop });
}
