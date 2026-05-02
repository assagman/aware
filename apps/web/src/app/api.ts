export const API_BASE = "/api";

async function parse<T>(response: Response): Promise<T> {
	if (!response.ok) throw new Error(await response.text());
	const text = await response.text();
	return (text ? JSON.parse(text) : null) as T;
}

export async function apiGet<T>(path: string): Promise<T> {
	return parse<T>(await fetch(`${API_BASE}${path}`));
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
	return parse<T>(
		await fetch(`${API_BASE}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
	return parse<T>(
		await fetch(`${API_BASE}${path}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

export async function apiDelete<T>(path: string): Promise<T> {
	return parse<T>(
		await fetch(`${API_BASE}${path}`, {
			method: "DELETE",
		}),
	);
}
