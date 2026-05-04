import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TableName } from "./schema";

type Row = { id: string; [key: string]: unknown };

const dbPath =
	process.env.AWARE_DB ??
	process.env.DB_PATH ??
	join(process.cwd(), ".aware", "db.sqlite");

export class SqliteDb {
	private db: DatabaseSync;

	constructor() {
		this.init();
		this.db = new DatabaseSync(dbPath);
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS rows (table_name TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (table_name, id))",
		);
	}

	private init() {
		mkdir(dirname(dbPath), { recursive: true }).catch(() => {});
	}

	async list<T extends Row>(table: TableName): Promise<T[]> {
		const rows = this.db
			.prepare(
				"SELECT data FROM rows WHERE table_name = ? ORDER BY updated_at ASC",
			)
			.all(table) as { data: string }[];
		return rows.map((row) => JSON.parse(row.data) as T);
	}

	async insert<T extends Row>(table: TableName, row: T): Promise<T> {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO rows (table_name, id, data, updated_at) VALUES (?, ?, ?, ?)",
			)
			.run(table, row.id, JSON.stringify(row), new Date().toISOString());
		return row;
	}

	async update<T extends Row>(
		table: TableName,
		id: string,
		patch: Partial<T>,
	): Promise<T | null> {
		const found = this.db
			.prepare("SELECT data FROM rows WHERE table_name = ? AND id = ?")
			.get(table, id) as { data: string } | undefined;
		if (!found) return null;
		const row = { ...(JSON.parse(found.data) as Row), ...patch, id } as T;
		await this.insert(table, row);
		return row;
	}

	async delete(table: TableName, id: string): Promise<void> {
		this.db
			.prepare("DELETE FROM rows WHERE table_name = ? AND id = ?")
			.run(table, id);
	}
}

export const db = new SqliteDb();
