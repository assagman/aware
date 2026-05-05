import type { AgentProfile, Annotation, Task } from "@aware/shared";
import {
	annotationSentPromptTemplate,
	renderPromptTemplate,
	runInstructionsPrompt,
	taskPromptTemplate,
} from "../../prompts";

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
	const instructions = runInstructionsPrompt.split("\n");
	if (isAnnotationSent) {
		return renderPromptTemplate(annotationSentPromptTemplate, {
			body: serializeAnnotations(input.annotations) || input.message || input.task.body,
			instructions: instructions.join("\n"),
		});
	}
	return renderPromptTemplate(taskPromptTemplate, {
		taskTitle: input.task.title,
		taskBody: input.task.body,
		userMessage: input.message || input.task.body,
		agents: serializeAgents(input.agents) || "(none)",
		annotations: serializeAnnotations(input.annotations) || "(none)",
		instructions: instructions.join("\n"),
	});
}
