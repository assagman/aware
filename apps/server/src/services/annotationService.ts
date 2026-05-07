import { randomUUID } from "node:crypto";
import type { Annotation, AnnotationSuggestionTargetKind, AnnotationTaskSuggestion } from "@aware/shared";
import { db } from "../db/client";

const now = () => new Date().toISOString();

export type AnnotationListState = "active" | "archived" | "all";
export type AnnotationFilter = Partial<Pick<Annotation, "projectId" | "taskId" | "worktreeId">> & {
	state?: AnnotationListState;
};

function isDeleted(annotation: Annotation) {
	return Boolean((annotation as Annotation & { deleted?: boolean }).deleted);
}

function isArchived(annotation: Annotation) {
	return Boolean(annotation.archivedAt) || annotation.status === "archived";
}

export async function listAnnotations(filter: AnnotationFilter = {}) {
	const rows = await db.list<Annotation>("annotations");
	const state = filter.state ?? "active";
	return rows.filter(
		(annotation) =>
			!isDeleted(annotation) &&
			!(annotation as Annotation & { resolved?: boolean }).resolved &&
			(state === "all" || (state === "archived" ? isArchived(annotation) : !isArchived(annotation))) &&
			(!filter.projectId || annotation.projectId === filter.projectId) &&
			(!filter.taskId || annotation.taskId === filter.taskId) &&
			(!filter.worktreeId || annotation.worktreeId === filter.worktreeId),
	);
}

export async function getAnnotationInProject(projectId: string, annotationId: string, state: AnnotationListState = "all") {
	return (await listAnnotations({ projectId, state })).find((row) => row.id === annotationId);
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

export async function updateAnnotation(annotationId: string, patch: Partial<Annotation>) {
	return db.update<Annotation>("annotations", annotationId, { ...patch, updatedAt: now() });
}

export async function archiveAnnotation(projectId: string, annotationId: string) {
	const annotation = await getAnnotationInProject(projectId, annotationId, "all");
	if (!annotation) return null;
	return updateAnnotation(annotation.id, { archivedAt: now(), status: "archived" });
}

export async function restoreAnnotation(projectId: string, annotationId: string) {
	const annotation = await getAnnotationInProject(projectId, annotationId, "all");
	if (!annotation) return null;
	const { archivedAt: _archivedAt, ...restored } = {
		...annotation,
		status: annotation.sent ? "sent" as const : "pending" as const,
		updatedAt: now(),
	};
	await db.insert("annotations", restored);
	return restored;
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
				a.worktreeId ? `  worktreeId: ${a.worktreeId}` : "",
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

export async function getAnnotationTaskSuggestion(projectId: string, suggestionId: string) {
	return (await listAnnotationTaskSuggestions(projectId)).find((row) => row.id === suggestionId);
}

export async function saveAnnotationTaskSuggestions(input: {
	projectId: string;
	sourceRunId?: string | undefined;
	suggestions: Array<{
		title: string;
		body?: string | undefined;
		targetKind?: AnnotationSuggestionTargetKind | undefined;
		annotationIds?: string[] | undefined;
		worktreeId?: string | undefined;
		taskId?: string | undefined;
	}>;
}) {
	const stamp = now();
	const rows = input.suggestions.map<AnnotationTaskSuggestion>((suggestion) => ({
		id: randomUUID(),
		projectId: input.projectId,
		title: suggestion.title.trim(),
		body: suggestion.body ?? "",
		status: "draft",
		...(suggestion.targetKind ? { targetKind: suggestion.targetKind } : {}),
		...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
		...(suggestion.annotationIds?.length ? { annotationIds: suggestion.annotationIds } : {}),
		...(suggestion.worktreeId ? { worktreeId: suggestion.worktreeId } : {}),
		...(suggestion.taskId ? { taskId: suggestion.taskId } : {}),
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
