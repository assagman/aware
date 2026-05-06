import { randomUUID } from "node:crypto";
import type { Annotation, AnnotationTaskSuggestion } from "@aware/shared";
import { db } from "../db/client";

const now = () => new Date().toISOString();

export type AnnotationFilter = Partial<Pick<Annotation, "projectId" | "taskId" | "worktreeId">>;

export async function listAnnotations(filter: AnnotationFilter = {}) {
	const rows = await db.list<Annotation>("annotations");
	return rows.filter(
		(a) =>
			!(a as Annotation & { deleted?: boolean }).deleted &&
			!(a as Annotation & { resolved?: boolean }).resolved &&
			(!filter.projectId || a.projectId === filter.projectId) &&
			(!filter.taskId || a.taskId === filter.taskId) &&
			(!filter.worktreeId || a.worktreeId === filter.worktreeId),
	);
}

export async function getAnnotationInProject(projectId: string, annotationId: string) {
	return (await listAnnotations({ projectId })).find((row) => row.id === annotationId);
}

export async function createAnnotation(
	input: Omit<Annotation, "id" | "createdAt" | "updatedAt" | "sent"> & {
		sent?: boolean;
	},
) {
	const stamp = now();
	const row: Annotation = {
		...input,
		id: randomUUID(),
		sent: input.sent ?? false,
		status: input.status ?? "pending",
		createdAt: stamp,
		updatedAt: stamp,
	};
	return db.insert("annotations", row);
}

export async function moveAnnotationsToWorktree(
	ids: string[],
	worktreeId: string,
	projectId: string,
) {
	await Promise.all(
		ids.map((id) =>
			db.update<Annotation>("annotations", id, {
				projectId,
				worktreeId,
				updatedAt: now(),
			}),
		),
	);
}

export async function markAnnotationsProcessing(ids: string[], runId: string) {
	await Promise.all(
		ids.map((id) =>
			db.update<Annotation>("annotations", id, {
				status: "processing",
				runId,
				updatedAt: now(),
			}),
		),
	);
}

export async function markAnnotationsSent(ids: string[]) {
	await Promise.all(
		ids.map((id) =>
			db.update<Annotation>("annotations", id, {
				sent: true,
				status: "sent",
				updatedAt: now(),
			}),
		),
	);
}

export function annotationLocation(annotation: Pick<Annotation, "filePath" | "startLine" | "endLine">) {
	const path = annotation.filePath ?? "(missing file)";
	if (!annotation.startLine) return path;
	return annotation.endLine && annotation.endLine !== annotation.startLine
		? `${path}:${annotation.startLine}-${annotation.endLine}`
		: `${path}:${annotation.startLine}`;
}

export function serializeAnnotations(annotations: Annotation[]) {
	return annotations
		.map((a) => {
			const blocks = [
				`- ${a.kind} ${annotationLocation(a)}${a.text ? `: ${a.text}` : ""}`,
				a.side ? `  side: ${a.side}` : "",
				a.selectedText ? `  exact text:\n${indent(a.selectedText)}` : "",
				a.context ? `  context:\n${indent(a.context)}` : "",
			].filter(Boolean);
			return blocks.join("\n");
		})
		.join("\n");
}

function indent(value: string) {
	return value.split(/\r?\n/).map((line) => `    ${line}`).join("\n");
}

export async function listAnnotationTaskSuggestions(projectId: string) {
	return (await db.list<AnnotationTaskSuggestion>("annotationTaskSuggestions"))
		.filter((row) => row.projectId === projectId)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveAnnotationTaskSuggestions(input: {
	projectId: string;
	sourceRunId?: string | undefined;
	suggestions: Array<{ title: string; body?: string | undefined; annotationIds?: string[] | undefined }>;
}) {
	const stamp = now();
	const rows = input.suggestions.map<AnnotationTaskSuggestion>((suggestion) => ({
		id: randomUUID(),
		projectId: input.projectId,
		title: suggestion.title.trim(),
		body: suggestion.body ?? "",
		status: "draft",
		...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
		...(suggestion.annotationIds?.length ? { annotationIds: suggestion.annotationIds } : {}),
		createdAt: stamp,
		updatedAt: stamp,
	}));
	await Promise.all(rows.map((row) => db.insert("annotationTaskSuggestions", row)));
	return rows;
}

export async function markAnnotationTaskSuggestions(
	ids: string[],
	patch: Partial<AnnotationTaskSuggestion>,
) {
	const stamp = now();
	return Promise.all(
		ids.map((id) => db.update<AnnotationTaskSuggestion>("annotationTaskSuggestions", id, { ...patch, updatedAt: stamp })),
	);
}
