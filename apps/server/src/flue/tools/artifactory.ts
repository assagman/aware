import { Type, type ToolDef } from "@flue/sdk/client";
import { artifactorySaveSessionReportInputSchema, type AgentRun, type Task } from "@aware/shared";
import { saveSessionReport } from "../../services/artifactoryService";

const artifactoryToolNames = ["artifactory_save_session_report"] as const;

export type ArtifactoryToolName = (typeof artifactoryToolNames)[number];
export const ARTIFACTORY_TOOL_NAMES: readonly ArtifactoryToolName[] = artifactoryToolNames;

export type ArtifactoryToolContext = {
	run: AgentRun;
	task: Task;
	turnSeq: () => number;
};

function stringifyResult(result: unknown) {
	return JSON.stringify(result, null, 2);
}

export function createArtifactoryTools(context: ArtifactoryToolContext): ToolDef[] {
	return [
		{
			name: "artifactory_save_session_report",
			description: [
				"Save concise session report for current Aware run turn.",
				"Call once near end of every turn before final answer/stop.",
				"Include goal, actions taken, files changed/read, commands/tests run, decisions, blockers, and next steps.",
				"Aware appends the final assistant message to the report at turn_end automatically.",
				"Do not include secrets or long raw logs.",
			].join(" "),
			parameters: Type.Object({
				title: Type.Optional(Type.String({ description: "Short report title." })),
				body: Type.String({ description: "Markdown session report before final reply. Concise but enough for downstream runs; final assistant message is appended at turn_end." }),
				metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional small structured metadata." })),
			}),
			execute: async (args) => {
				const parsed = artifactorySaveSessionReportInputSchema.parse(args);
				const artifact = await saveSessionReport({
					run: context.run,
					task: context.task,
					turnSeq: context.turnSeq(),
					...(parsed.title ? { title: parsed.title } : {}),
					body: parsed.body,
					...(parsed.metadata ? { metadata: parsed.metadata } : {}),
					source: "agent",
				});
				return stringifyResult({ ok: true, artifact });
			},
		},
	];
}
