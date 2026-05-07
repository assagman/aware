import { Type, type ToolDef } from "@flue/sdk/client";
import { thoughtGraphSchema } from "@aware/shared";
import { db } from "../../db/client";
import {
	currentThoughtGraphAnalyzerInput,
	saveThoughtGraphArtifact,
} from "../../services/thoughtGraphService";

const thoughtToolNames = [
	"thought_fetch_run_events",
	"thought_fetch_artifacts",
	"thought_save_graph",
] as const;

export type ThoughtToolName = (typeof thoughtToolNames)[number];
export const THOUGHT_TOOL_NAMES: readonly ThoughtToolName[] = thoughtToolNames;

export type ThoughtToolContext = {
	runId: string;
};

function stringifyResult(result: unknown) {
	return JSON.stringify(result, null, 2);
}

function scopedRunId(context: ThoughtToolContext, requested: unknown) {
	if (typeof requested === "string" && requested && requested !== context.runId)
		throw new Error("Thought tools are scoped to the current run only.");
	return context.runId;
}

const optionalRunId = Type.Optional(Type.String({ description: "Must match current run id if provided." }));

export function createThoughtTools(context: ThoughtToolContext): ToolDef[] {
	return [
		{
			name: "thought_fetch_run_events",
			description: "Read all run-local source events and non-ThoughtGraph artifacts for the current run. Includes tool calls/results, thinking deltas, messages, turn markers, and session reports so the LLM can interpret context; graph output must still be distilled.",
			parameters: Type.Object({ runId: optionalRunId }),
			execute: async (args) => {
				const runId = scopedRunId(context, args.runId);
				return stringifyResult(await currentThoughtGraphAnalyzerInput(runId));
			},
		},
		{
			name: "thought_fetch_artifacts",
			description: "Read all non-ThoughtGraph artifacts for the current run, including session reports. Use as private context, not as raw graph output.",
			parameters: Type.Object({ runId: optionalRunId }),
			execute: async (args) => {
				const runId = scopedRunId(context, args.runId);
				const artifacts = (await db.list("runArtifacts")).filter((artifact) => artifact.runId === runId && artifact.kind !== "thought_graph");
				return stringifyResult({ artifacts });
			},
		},
		{
			name: "thought_save_graph",
			description: "Save strict ThoughtGraph JSON for current run as a thought_graph artifact. Does not modify files/tasks/branches.",
			parameters: Type.Object({
				runId: optionalRunId,
				graphJson: Type.String({ description: "ThoughtGraph JSON string matching shared schema." }),
			}),
			execute: async (args) => {
				const runId = scopedRunId(context, args.runId);
				const parsed = thoughtGraphSchema.parse(JSON.parse(String(args.graphJson)));
				if (parsed.runId !== runId) throw new Error("Thought graph runId must match current run.");
				const artifact = await saveThoughtGraphArtifact(runId, parsed, "thought-agent");
				return stringifyResult({ ok: true, artifact });
			},
		},
	];
}
