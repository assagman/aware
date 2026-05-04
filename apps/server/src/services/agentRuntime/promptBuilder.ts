import type { AgentProfile, Annotation, Task } from "@aware/shared";

function serializeAnnotations(annotations: Annotation[]) {
	return annotations
		.map(
			(a) =>
				`- ${a.kind} ${a.filePath ?? ""}${a.startLine ? `:${a.startLine}${a.endLine ? `-${a.endLine}` : ""}` : ""}: ${a.text}`,
		)
		.join("\n");
}

function serializeAgents(agents: AgentProfile[]) {
	return agents
		.map((agent, index) => {
			const details = [
				`provider ${agent.provider}`,
				`model ${agent.model}`,
				`thinking ${agent.thinking ?? "off"}`,
				agent.tools.length ? `tools ${agent.tools.join(", ")}` : "no tools",
			];
			return `- ${agent.name}${index === 0 ? " (selected)" : ""}: ${details.join("; ")}`;
		})
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
		"- Work only in assigned worktree under /workspace/<category>/<slug>.",
		"- Do not create or switch git worktrees; Worktree agent resolves this before run start.",
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
		"Available agents:",
		serializeAgents(input.agents) || "(none)",
		"",
		"Selected annotations:",
		serializeAnnotations(input.annotations) || "(none)",
		"",
		...instructions,
	].join("\n");
}
