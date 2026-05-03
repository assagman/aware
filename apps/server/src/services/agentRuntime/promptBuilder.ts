import type { AgentProfile, Annotation, Task } from "@aware/shared";

function serializeAnnotations(annotations: Annotation[]) {
	return annotations
		.map(
			(a) =>
				`- ${a.kind} ${a.filePath ?? ""}${a.startLine ? `:${a.startLine}${a.endLine ? `-${a.endLine}` : ""}` : ""}: ${a.text}`,
		)
		.join("\n");
}

export function buildPrompt(input: {
	task: Task;
	agents: AgentProfile[];
	annotations: Annotation[];
	message?: string;
}) {
	const isAnnotationSent = input.task.title === "annotation-sent";
	const instructions = [
		"Instructions:",
		"- Resolve worktree first. If selected worktree is main/master, create a new git worktree before mutating files.",
		"- Work only in resolved non-default worktree.",
		"- Keep changes minimal and focused.",
		"- Respect exact file paths and line ranges in annotations.",
		"- If line numbers seem stale, inspect nearby code before editing.",
		"- Do not run git commit or git push unless user explicitly approves.",
	];
	if (isAnnotationSent) {
		return [
			serializeAnnotations(input.annotations) ||
				input.message ||
				input.task.body,
			"",
			...instructions,
		].join("\n");
	}
	return [
		`Task: ${input.task.title}`,
		input.task.body,
		"",
		"User message:",
		input.message || input.task.body,
		"",
		"Selected annotations:",
		serializeAnnotations(input.annotations) || "(none)",
		"",
		...instructions,
	].join("\n");
}
