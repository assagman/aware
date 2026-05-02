import type { SessionData, SessionStore } from "@flue/sdk/client";
import { db } from "../../db/client";

export class DbSessionStore implements SessionStore {
	async save(id: string, data: SessionData) {
		const existing = (
			await db.list<{ id: string; data: SessionData }>("runEvents")
		).find((r) => r.id === id);
		if (existing) await db.update("runEvents", id, { data });
		else await db.insert("runEvents", { id, data });
	}
	async load(id: string) {
		return (
			(await db.list<{ id: string; data: SessionData }>("runEvents")).find(
				(r) => r.id === id,
			)?.data ?? null
		);
	}
	async delete(id: string) {
		await db.update("runEvents", id, { deleted: true });
	}
}
