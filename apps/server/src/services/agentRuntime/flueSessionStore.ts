import type { SessionData, SessionStore } from "@flue/sdk/client";
import { db } from "../../db/client";

type StoredSession = { id: string; data: SessionData; deleted?: boolean };

export class FlueSqliteSessionStore implements SessionStore {
	async save(id: string, data: SessionData) {
		await db.insert<StoredSession>("flueSessions", { id, data });
	}
	async load(id: string) {
		const row = (await db.list<StoredSession>("flueSessions")).find(
			(r) => r.id === id && !r.deleted,
		);
		return row?.data ?? null;
	}
	async delete(id: string) {
		await db.update<StoredSession>("flueSessions", id, { deleted: true });
	}
}

export const flueSessionStore = new FlueSqliteSessionStore();
