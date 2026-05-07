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
		.map((a) => {
			const location = `${a.filePath ?? ""}${a.startLine ? `:${a.startLine}${a.endLine && a.endLine !== a.startLine ? `-${a.endLine}` : ""}` : ""}`;
			return [
				`- ${a.kind} ${location}${a.text ? `: ${a.text}` : ""}`,
				a.side ? `  side: ${a.side}` : "",
				a.selectedText ? `  exact text:\n${indent(a.selectedText)}` : "",
				a.context ? `  context:\n${indent(a.context)}` : "",
			].filter(Boolean).join("\n");
		})
		.join("\n");
}

function indent(value: string) {
	return value.split(/\r?\n/).map((line) => `    ${line}`).join("\n");
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
	const isAnnotationSent = input.task.title === "annotation-sent" || input.task.source === "annotation-run";
	const instructions = runInstructionsPrompt.split("\n");
	if (isAnnotationSent) {
		const annotations = serializeAnnotations(input.annotations);
		const body = input.message?.trim()
			? annotations && !input.message.includes(annotations)
				? `${input.message.trim()}\n\n## Selected annotations\n\n${annotations}`
				: input.message.trim()
			: annotations || input.task.body;
		return renderPromptTemplate(annotationSentPromptTemplate, {
			body,
			instructions: instructions.join("\n"),
		});
	}
	return renderPromptTemplate(taskPromptTemplate, {
		projectId: input.task.projectId,
		taskId: input.task.id,
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
