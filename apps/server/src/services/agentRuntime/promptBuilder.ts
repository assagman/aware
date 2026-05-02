import type { AgentProfile, Annotation, Task } from "@agent-ide/shared";

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
		"Instructions:",
		"- Work only in selected worktree.",
		"- Keep changes minimal and focused.",
		"- Respect exact file paths and line ranges in annotations.",
		"- If line numbers seem stale, inspect nearby code before editing.",
		"- Do not run git commit or git push unless user explicitly approves.",
	].join("\n");
}
