import { graphCommandSchemas } from "@aware/shared";
import { Hono } from "hono";
import { z } from "zod";

export const tools = new Hono();

type JsonSchema = Record<string, unknown>;

function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
	if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema.removeDefault());
	if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
		return zodToJsonSchema(schema.unwrap());
	if (schema instanceof z.ZodString) return { type: "string" };
	if (schema instanceof z.ZodNumber) return { type: "number" };
	if (schema instanceof z.ZodBoolean) return { type: "boolean" };
	if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options };
	if (schema instanceof z.ZodArray)
		return { type: "array", items: zodToJsonSchema(schema.element) };
	if (schema instanceof z.ZodObject) {
		const shape = schema.shape;
		const properties: Record<string, JsonSchema> = {};
		const required: string[] = [];
		for (const [key, value] of Object.entries(shape)) {
			properties[key] = zodToJsonSchema(value as z.ZodTypeAny);
			if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault))
				required.push(key);
		}
		return {
			type: "object",
			properties,
			additionalProperties: false,
			...(required.length ? { required } : {}),
		};
	}
	return {};
}

const descriptions: Record<keyof typeof graphCommandSchemas, string> = {
	create_project: "Register a git project and sync its worktrees.",
	create_task: "Create a task inside a project graph.",
	update_task: "Update task title, body, worktree, or archive/delete state.",
	mark_task_done: "Mark task done after all active runs are done.",
	archive_task: "Archive task into history without deleting its worktree or branch.",
	start_run: "Start a task-lane or gate-lane agent run for a task.",
	send_run_message: "Send a steering/continue message to an existing run.",
	retry_run: "Create a new run from an existing run request.",
	delete_run: "Soft-delete a run from active graph logic.",
	create_checkpoint: "Mark gate after task review.",
	start_shipping: "Start internal Shipping Agent final run for a task.",
	open_project: "Open focused project route.",
	open_checkpoint: "Open gate route.",
	open_ship: "Open shipping route.",
	open_task: "Open task route.",
	open_run: "Open canonical run route.",
	open_files: "Open worktree files route.",
	open_diffs: "Open worktree diffs route.",
	open_annotations: "Open project annotations route.",
	open_annotation_tasks: "Open AnnotationTasks approval route.",
};

tools.get("/graph", (c) =>
	c.json({
		version: 1,
		generatedAt: new Date().toISOString(),
		tools: Object.entries(graphCommandSchemas).map(([name, schema]) => ({
			name,
			description: descriptions[name as keyof typeof graphCommandSchemas],
			inputSchema: zodToJsonSchema(schema),
		})),
	}),
);
