import { randomUUID } from "node:crypto";
import type { Annotation } from "@agent-ide/shared";
import { db } from "../db/client";

const now = () => new Date().toISOString();

export async function listAnnotations(
	filter: Partial<Pick<Annotation, "taskId" | "worktreeId">> = {},
) {
	const rows = await db.list<Annotation>("annotations");
	return rows.filter(
		(a) =>
			!a.sent &&
			!(a as Annotation & { deleted?: boolean }).deleted &&
			!(a as Annotation & { resolved?: boolean }).resolved &&
			(!filter.taskId || a.taskId === filter.taskId) &&
			(!filter.worktreeId || a.worktreeId === filter.worktreeId),
	);
}

export async function createAnnotation(
	input: Omit<Annotation, "id" | "createdAt" | "updatedAt" | "sent"> & {
		sent?: boolean;
	},
) {
	const row: Annotation = {
		...input,
		id: randomUUID(),
		sent: input.sent ?? false,
		createdAt: now(),
		updatedAt: now(),
	};
	return db.insert("annotations", row);
}

export async function markAnnotationsSent(ids: string[]) {
	await Promise.all(
		ids.map((id) =>
			db.update<Annotation>("annotations", id, {
				sent: true,
				updatedAt: now(),
			}),
		),
	);
}

export function serializeAnnotations(annotations: Annotation[]) {
	return annotations
		.map(
			(a) =>
				`- ${a.kind} ${a.filePath ?? ""}${a.startLine ? `:${a.startLine}${a.endLine ? `-${a.endLine}` : ""}` : ""}: ${a.text}`,
		)
		.join("\n");
}
