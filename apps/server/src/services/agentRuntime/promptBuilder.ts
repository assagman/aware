import type { Annotation, Task } from "@aware/shared";
import {
	annotationSentPromptTemplate,
	renderPromptTemplate,
	runInstructionsPrompt,
	taskPromptTemplate,
} from "../../prompts";
import { runtimeAgentRoleName, type RuntimeAgent } from "./runtimeAgent";

function serializeAnnotations(annotations: Annotation[]) {
	return annotations
		.map(
			(a) =>
				`- ${a.kind} ${a.filePath ?? ""}${a.startLine ? `:${a.startLine}${a.endLine ? `-${a.endLine}` : ""}` : ""}: ${a.text}`,
		)
		.join("\n");
}

function serializeSelectedAgent(agent: RuntimeAgent | undefined) {
	if (!agent) return "(none)";
	const details = [
		`provider ${agent.provider}`,
		`model ${agent.model}`,
		`thinking ${agent.thinking ?? "off"}`,
		agent.tools.length ? `tools ${agent.tools.join(", ")}` : "no tools",
	];
	return `- ${agent.name}: ${details.join("; ")}`;
}

function serializeAvailableAgents(agents: RuntimeAgent[]) {
	return agents
		.slice(1)
		.map((agent) => {
			const details = [
				`role ${runtimeAgentRoleName(agent)}`,
				agent.internal ? "internal service" : "agent profile",
				agent.description,
			].filter(Boolean);
			return `- ${agent.name}: ${details.join("; ")}`;
		})
		.join("\n");
}

export function buildPrompt(input: {
	task: Task;
	agents: RuntimeAgent[];
	annotations: Annotation[];
	message?: string;
	upstreamArtifacts?: string;
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
		selectedAgent: serializeSelectedAgent(input.agents[0]),
		agents: serializeAvailableAgents(input.agents) || "(none)",
		annotations: serializeAnnotations(input.annotations) || "(none)",
		upstreamArtifacts: input.upstreamArtifacts || "(none)",
		instructions: instructions.join("\n"),
	});
}
